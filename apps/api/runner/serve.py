"""LearnSDLC runner service: the sandbox behind a UNIX socket.

A small HTTP server bound to the path in RUNNER_SOCKET. The API (in
RUNNER_MODE=socket) POSTs a job JSON to /execute and receives the same result
JSON that the stdin CLI in sandbox_runner.py prints and lambda_handler.py
returns: one execution contract, three transports.

Why a socket and not a port: the runner container runs with network_mode:
none, so a UNIX socket on a shared volume is the only way in, and a learner
process that somehow escaped the rlimits still has no route to postgres,
redis or the internet. Why not the docker socket: handing the API a docker
socket would make a compromised API root on the host.

How many jobs at once: RUNNER_SLOTS, the same variable and the same default
the API's own gate uses (apps/api/src/config/runner.ts). A job past the cap
waits in line for RUNNER_MAX_WAIT_MS and is then answered 503; a job arriving
to a line already RUNNER_QUEUE_DEPTH long is answered 503 straight away.
Neither is ever killed, and GET /health reports the pool so an operator can
see the queue.

Two contracts, not one. `/execute` runs a job to completion, which is what
grading is. `/app/*` supervises a learner's own application while they click
around in it, which is the other shape and lives in
app_session.py. They share this server, this socket and this pool, and they are
bounded differently on purpose: a job holds a pool slot for as long as it runs,
while a preview holds one only for its build: a session that held a slot for
its ten minutes would starve a class of thirty behind two previews.

Also usable outside Docker (CI, a developer laptop):

    RUNNER_SOCKET=/tmp/runner.sock python3 apps/api/runner/serve.py

    python3 apps/api/runner/serve.py --check     # health probe, exit 0/1
"""

import http.client
import json
import os
import signal
import socket
import socketserver
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler

import app_session
from app_session import note, positive_int
from sandbox_runner import confinement_note, execute_job, protect_own_memory, isolation_status

DEFAULT_SOCKET = "/run/learnsdlc/runner.sock"
# A workspace is a handful of source files; anything larger is not a job.
MAX_BODY_BYTES = 16 * 1024 * 1024


def socket_path():
    return os.environ.get("RUNNER_SOCKET") or DEFAULT_SOCKET


# --------------------- stopping when nobody is using it ---------------------
#
# The compose runner is a service and runs until the container does; this is
# for the other deployment. On RUNNER_MODE=local the API
# starts a runner of its own for the live preview, and the API is not always
# the thing that ends: a killed test run, a CLI that was Ctrl-C'd, a jest
# worker whose sandboxed `process` never fires the parent's exit handler. Each
# of those would leave a runner bound to a socket forever, and the next one
# would refuse to bind over it.
#
# So a runner that was asked to may stop itself: no request for this long and
# no live preview session, and it unwinds through serve()'s own `finally`,
# stopping anything it still holds and removing its socket. Unset, which is
# every container, means never.

#: Monotonic time of the last request this server answered.
LAST_REQUEST = time.monotonic()


def idle_exit_seconds(env=None):
    env = os.environ if env is None else env
    try:
        value = int(str(env.get("RUNNER_IDLE_EXIT_SECONDS", "")).strip())
    except (TypeError, ValueError):
        return 0
    return value if value > 0 else 0


# ------------------------- how many jobs at once ----------------------------
#
# The runner needs a cap of its own. `request_queue_size` below is the
# listen backlog (how many connections the kernel holds before it refuses one)
# and ThreadingMixIn starts a thread per accepted connection, so without a
# cap every job that arrives runs immediately. The API's own gate
# (execution/run-gate.ts, sized to RUNNER_SLOTS) is a per-API-process
# number: docker-compose.yml sizes this container's memory as one API
# replica's worth of runs and documents a multi-replica shape in the same
# file, and two replicas each honouring their own gate would put twice that
# many children in here. A container that is over its `mem_limit` is killed by
# the kernel, and a killed runner takes every in-flight learner's run with it.
#
# So the cap lives here too, sized from the same environment variable the API
# reads and defaulted by the same arithmetic (config/runner.ts: RUNNER_SLOTS, else
# JOB_CONCURRENCY + 2, else max(2, cpus - 1) + 2). Point both at the same
# number and the runner enforces what the API already promises; leave the API
# out of the picture entirely and the runner still cannot be pushed past what
# the container is provisioned for.


def host_parallelism():
    return max(1, os.cpu_count() or 1)


def job_concurrency(env=None):
    env = os.environ if env is None else env
    return positive_int(env.get("JOB_CONCURRENCY"), max(2, host_parallelism() - 1))


def runner_slots(env=None):
    """Jobs that may execute at once. The same name and default as the API's gate."""
    env = os.environ if env is None else env
    return positive_int(env.get("RUNNER_SLOTS"), job_concurrency(env) + 2)


def runner_max_wait_ms(env=None):
    """How long a job waits for a slot before it is refused. As RUNNER_MAX_WAIT_MS on the API."""
    env = os.environ if env is None else env
    return positive_int(env.get("RUNNER_MAX_WAIT_MS"), 120_000)


def runner_queue_depth(env=None):
    """How many jobs may wait at once.

    Deliberately *not* the API's RUNNER_MAX_WAITING (default 200). A waiter
    there is a pending promise on one event loop; a waiter here is an OS
    thread, and the production container runs with `pids_limit: 128`
    (docker-compose.yml), which has to cover the accept thread, the waiting
    threads and every sandbox child. Four deep per slot is a queue an operator
    can see in the health endpoint and still leaves the pid budget for the
    runs themselves.
    """
    env = os.environ if env is None else env
    return positive_int(env.get("RUNNER_QUEUE_DEPTH"), max(8, runner_slots(env) * 4))


class Busy(Exception):
    """No slot for this job. `reason` separates a slow line from a full one."""

    def __init__(self, reason, waited_ms):
        super().__init__(f"runner busy: {reason}")
        self.reason = reason
        self.waited_ms = waited_ms


class JobPool:
    """A fair, fixed-size, bounded admission gate around execute_job.

    First in, first served: a waiter is admitted only at the head of the line,
    so a burst on one route cannot starve the jobs behind it. The wait carries
    a deadline and the line carries a ceiling for the reason the API's gate
    does: an unbounded FIFO turns a class-sized burst into connections held
    open for as long as the burst takes to drain, with the API, the proxy and
    the learner all giving up somewhere in the middle and retrying into the
    same line. Past either bound the answer is a 503, which
    `sandbox.service.ts` already turns into the `unavailable` outcome:
    the learner is told the runner could not take the work, their files are
    untouched, and no attempt is spent.
    """

    def __init__(self, slots, max_wait_ms=None, queue_depth=None):
        if slots < 1:
            raise ValueError(f"runner slots must be at least 1, got {slots}")
        self.slots = slots
        self.max_wait_s = (120_000 if max_wait_ms is None else max_wait_ms) / 1000.0
        self.queue_depth = max(1, slots * 4) if queue_depth is None else queue_depth
        self._lock = threading.Lock()
        self._free = threading.Condition(self._lock)
        self._in_flight = 0
        self._line = deque()
        # Cumulative, for the health endpoint: an operator asking why a lab
        # felt slow wants the number of refusals, not the instantaneous zero.
        self._refused = 0

    def stats(self):
        with self._lock:
            return {
                "slots": self.slots,
                "inFlight": self._in_flight,
                "waiting": len(self._line),
                "refused": self._refused,
                "queueDepth": self.queue_depth,
            }

    def acquire(self):
        """Take a slot, waiting in line for one. Raises Busy rather than blocking for ever."""
        started = time.monotonic()
        with self._lock:
            if self._in_flight < self.slots and not self._line:
                self._in_flight += 1
                return
            if len(self._line) >= self.queue_depth:
                self._refused += 1
                raise Busy("queue-full", 0)
            ticket = object()
            self._line.append(ticket)
            deadline = started + self.max_wait_s
            try:
                while True:
                    if self._line[0] is ticket and self._in_flight < self.slots:
                        self._line.popleft()
                        self._in_flight += 1
                        # The new head may be admissible too, and only a
                        # waiter can notice that.
                        self._free.notify_all()
                        return
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        self._line.remove(ticket)
                        self._refused += 1
                        self._free.notify_all()
                        raise Busy("deadline", int((time.monotonic() - started) * 1000))
                    self._free.wait(remaining)
            except BaseException:
                # A thread killed while waiting must not leave its ticket at
                # the head of the line, blocking everyone behind it for ever.
                if ticket in self._line:
                    self._line.remove(ticket)
                    self._free.notify_all()
                raise

    def release(self):
        with self._lock:
            self._in_flight -= 1
            self._free.notify_all()


class JobHandler(BaseHTTPRequestHandler):
    server_version = "learnsdlc-runner/1"
    protocol_version = "HTTP/1.1"

    def _send_json(self, status, payload, retry_after=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
        self.end_headers()
        self.wfile.write(body)

    @property
    def pool(self):
        return self.server.pool

    def do_GET(self):
        if self.path == "/health":
            # Never gated: a probe that queues behind the jobs it is asking
            # about reports the runner as down exactly when it is merely busy.
            isolation = isolation_status()
            self._send_json(
                200,
                {
                    "ok": isolation["status"] == "ok",
                    "isolation": isolation,
                    "capabilities": {"runtimeDiagnostics": 1, "isolationReadiness": 1},
                    "pid": os.getpid(),
                    "uid": os.getuid(),
                    "pool": self.pool.stats(),
                    # Live previews are not pool work, so an operator asking why
                    # this container's memory is high has to be able to see them.
                    "app": app_session.stats(),
                },
            )
        else:
            self._send_json(404, {"error": "not found"})

    def _read_job(self):
        """The request body as a dict, or None once an answer has been sent."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length <= 0:
            self._send_json(411, {"error": "Content-Length required"})
            return None
        if length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "job too large"})
            return None
        raw = self.rfile.read(length)
        try:
            job = json.loads(raw)
            if not isinstance(job, dict):
                raise ValueError("job must be a JSON object")
        except ValueError as err:
            self._send_json(400, {"error": f"invalid job: {err}"})
            return None
        return job

    def do_POST(self):
        if self.path.startswith("/app/"):
            self._do_app()
            return
        if self.path != "/execute":
            self._send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length <= 0:
            self._send_json(411, {"error": "Content-Length required"})
            return
        if length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "job too large"})
            return
        raw = self.rfile.read(length)
        try:
            job = json.loads(raw)
            if not isinstance(job, dict):
                raise ValueError("job must be a JSON object")
        except ValueError as err:
            self._send_json(400, {"error": f"invalid job: {err}"})
            return

        started = time.monotonic()
        # Wait for a slot before touching the filesystem or spawning anything.
        # A refusal here costs the caller one round trip and this container
        # nothing, which is the whole point: over its memory limit the runner
        # is killed by the kernel and takes every in-flight learner with it.
        try:
            self.pool.acquire()
        except Busy as busy:
            stats = self.pool.stats()
            self.log_message(
                "job refused mode=%s reason=%s waited=%dms in_flight=%d waiting=%d",
                job.get("mode"), busy.reason, busy.waited_ms,
                stats["inFlight"], stats["waiting"],
            )
            # 503 and not 500: the request was fine, the capacity was not, and
            # a retry is the right answer. sandbox.service.ts turns any
            # non-200 into the `unavailable` outcome, so the learner is
            # told the runner could not take the work rather than being failed
            # by it. Retry-After is for an operator's proxy; the API reads
            # the body.
            self._send_json(
                503,
                {
                    "error": "runner busy",
                    "reason": busy.reason,
                    "waitedMs": busy.waited_ms,
                    "slots": stats["slots"],
                    "waiting": stats["waiting"],
                },
                retry_after=5,
            )
            return
        try:
            # execute_job builds and removes a fresh temp dir per job, so
            # concurrent jobs (one thread each) never see each other's files.
            result = execute_job(job)
        except ValueError as err:
            # illegal paths, unknown mode: the caller's fault, not a crash
            self._send_json(400, {"error": str(err)})
            return
        except Exception as err:  # noqa: BLE001 (must answer, whatever broke)
            self.log_error("job failed: %s: %s", type(err).__name__, err)
            self._send_json(500, {"error": f"runner failure: {type(err).__name__}"})
            return
        finally:
            # Whatever happened, including a send that failed on a caller that
            # had already hung up: a leaked slot wedges every later job.
            self.pool.release()
        self.log_message(
            "job mode=%s ok=%s exit=%s in %dms",
            job.get("mode"), result.get("ok"), result.get("exitKind"),
            int((time.monotonic() - started) * 1000),
        )
        self._send_json(200, result)

    # ------------------------------ the preview ----------------------------
    #
    # Five routes, the same JSON conventions, one difference that matters: what
    # takes a pool slot. `/app/start` builds a bundle and runs a seed, which is
    # real work and queues like a job. `/app/status`, `/app/proxy` and
    # `/app/asset` are a learner clicking a button in their own application;
    # queueing those behind a class's grading run would make the preview feel
    # broken, and they are bounded instead by the proxy timeout and by the
    # listen backlog.

    APP_ROUTES = ("start", "status", "stop", "proxy", "asset")

    def _do_app(self):
        route = self.path[len("/app/"):]
        if route not in self.APP_ROUTES:
            self._send_json(404, {"error": "not found"})
            return
        job = self._read_job()
        if job is None:
            return
        started = time.monotonic()
        try:
            if route == "start":
                try:
                    self.pool.acquire()
                except Busy as busy:
                    stats = self.pool.stats()
                    self.log_message(
                        "app start refused reason=%s waited=%dms in_flight=%d waiting=%d",
                        busy.reason, busy.waited_ms, stats["inFlight"], stats["waiting"],
                    )
                    self._send_json(
                        503,
                        {
                            "error": "runner busy",
                            "reason": busy.reason,
                            "waitedMs": busy.waited_ms,
                            "slots": stats["slots"],
                            "waiting": stats["waiting"],
                        },
                        retry_after=5,
                    )
                    return
                try:
                    answer = app_session.start(job)
                finally:
                    # Before the readiness probe, which runs on a thread of its
                    # own: the slot is for the build, not for the session.
                    self.pool.release()
                self.log_message(
                    "app start id=%s bundle=%s in %dms",
                    answer["id"], answer["bundleOk"],
                    int((time.monotonic() - started) * 1000),
                )
            elif route == "status":
                answer = app_session.status(job.get("id"), job.get("cursor") or 0)
            elif route == "stop":
                answer = app_session.stop(job.get("id"), job.get("reason") or "learner")
                self.log_message("app stop id=%s reason=%s", answer["id"], answer["stopReason"])
            elif route == "proxy":
                answer = app_session.proxy(
                    job.get("id"), job.get("method"), job.get("path"),
                    job.get("headers"), job.get("body"),
                )
            else:
                answer = app_session.asset(job.get("id"), job.get("path"))
        except app_session.UnknownSession:
            # 404 and not 403: a session that has been stopped, swept or never
            # existed are one answer, so nothing here tells a caller which.
            self._send_json(404, {"error": "not found"})
        except app_session.SessionNotReady as not_ready:
            self._send_json(409, {
                "error": "the app is not running",
                "status": not_ready.status,
                "message": not_ready.message,
            })
        except app_session.SessionsFull as full:
            self._send_json(503, {"error": "runner busy", "reason": full.reason}, retry_after=5)
        except ValueError as err:
            self._send_json(400, {"error": str(err)})
        except Exception as err:  # noqa: BLE001 (must answer, whatever broke)
            self.log_error("app %s failed: %s: %s", route, type(err).__name__, err)
            self._send_json(500, {"error": f"runner failure: {type(err).__name__}"})
        else:
            self._send_json(200, answer)

    def handle_one_request(self):
        global LAST_REQUEST
        LAST_REQUEST = time.monotonic()
        super().handle_one_request()

    # The peer of a UNIX socket has no address; the default implementation
    # indexes client_address[0] and would raise.
    def address_string(self):
        return "unix"

    def log_message(self, fmt, *args):
        # Through note: a dead log pipe would otherwise kill this request
        # thread mid-request, leaving the server bound and answering nothing.
        note("runner: " + (fmt % args))


class RunnerServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    # The kernel's listen backlog: how many connections wait to be *accepted*,
    # which is not a worker cap. What bounds the work is the
    # JobPool below; this only decides how many callers get an answer instead
    # of a connection refused while the accept loop is between calls.
    request_queue_size = 64

    def __init__(self, path, handler, pool=None):
        self.pool = pool or JobPool(
            runner_slots(), max_wait_ms=runner_max_wait_ms(), queue_depth=runner_queue_depth()
        )
        super().__init__(path, handler)


def serve(path):
    protect_own_memory()
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    if os.path.exists(path):
        # A stale socket from an unclean shutdown blocks bind(); a live one
        # means two runners were pointed at the same path.
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(path)
        except OSError:
            os.unlink(path)
        else:
            probe.close()
            sys.exit(f"runner: another runner is already serving {path}")
    # The API connects from a different uid (node, 1000) than the runner
    # (65534), so the socket must be writable by everyone on the shared volume.
    #
    # The umask is scoped to the bind() and restored immediately. A process-wide
    # 0o111 would strip the execute bit from every directory this process
    # creates afterwards (including each job's temp workspace), and a directory
    # without x cannot have entries made in it, so every job would die with
    # PermissionError. Root never sees that (CAP_DAC_OVERRIDE ignores directory
    # modes), so only a runner started as a non-root uid shows the failure.
    previous_umask = os.umask(0o111)
    try:
        server = RunnerServer(path, JobHandler)
    finally:
        os.umask(previous_umask)
    os.chmod(path, 0o666)
    note(
        f"runner: serving on {path} as uid {os.getuid()} pid {os.getpid()} "
        f"slots={server.pool.slots} queue={server.pool.queue_depth} "
        f"wait={int(server.pool.max_wait_s * 1000)}ms"
    )
    # Which fence holds around every child: Landlock where the kernel has it
    # (proved once, here, before the first job) and the in-process file policy
    # everywhere. An operator reading this line knows what a learner's run can
    # reach on this host.
    note(f"runner: {confinement_note()}")
    # The sweep's tick that enforces the idle, hard and byte caps. Started here
    # as well as on the first session, so a runner that is restarted with a
    # session register in memory (it never is) or one whose first caller is a
    # status poll still sweeps.
    app_session.start_sweeper()
    idle_exit = idle_exit_seconds()
    if idle_exit:
        threading.Thread(target=_exit_when_idle, args=(idle_exit,), daemon=True).start()
    try:
        server.serve_forever()
    finally:
        # A preview must never outlive the runner: the children are in our
        # process group, but a SIGTERM that unwinds cleanly leaves them running
        # until the group is killed, and a learner's app holding a port is the
        # one failure an operator cannot explain.
        stopped = app_session.stop_all("shutdown")
        if stopped:
            note(f"runner: stopped {stopped} preview session(s)")
        server.server_close()
        try:
            os.unlink(path)
        except OSError:
            pass


def _exit_when_idle(seconds, interval=5):
    """Stop this runner once nobody is using it. See idle_exit_seconds.

    A live preview session counts as use even while nobody is clicking: the
    app is running and the learner is looking at it. SIGTERM to ourselves
    rather than sys.exit, because the thread that notices is not the one
    inside serve_forever, and the signal is what unwinds it through the
    `finally` that stops the sessions and removes the socket.
    """
    while True:
        time.sleep(interval)
        if app_session.stats()["sessions"]:
            continue
        if time.monotonic() - LAST_REQUEST < seconds:
            continue
        note(f"runner: nothing for {seconds}s and no live preview, stopping")
        os.kill(os.getpid(), signal.SIGTERM)
        return


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._path)


def check(path):
    """Health probe for HEALTHCHECK: the image ships no curl on purpose."""
    try:
        conn = _UnixHTTPConnection(path, timeout=3)
        conn.request("GET", "/health")
        response = conn.getresponse()
        body = json.loads(response.read())
        return response.status == 200 and body.get("ok") is True
    except (OSError, ValueError):
        return False


def main(argv):
    path = socket_path()
    if "--check" in argv:
        sys.exit(0 if check(path) else 1)
    # SIGTERM from the orchestrator: unwind through serve() so the socket
    # file is removed; in-flight jobs are daemon threads and die with us.
    def stop(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    serve(path)


if __name__ == "__main__":
    main(sys.argv[1:])
