"""The live preview: one learner's own application, supervised.

`execute_job` runs a job to completion and throws the workspace away. A preview
is the other shape (a child that keeps running while its owner clicks around in
it), so it lives here, behind `/app/start` in serve.py, and everything that is
the same is shared rather than copied: `spawn_child` (the same rlimits, the same
`os.setsid`, the same environment allowlist), `reap_group` (the same fork-bomb
proof kill), `safe_join` (the same "does this path escape?" rule) and
`redact_workspace` (the same host paths stripped out of everything we return).

The shape is ONE child. The runner starts the learner's
Python API on a kernel-chosen loopback port and serves their built front end
itself out of `web/dist`, so the whole preview is one door: the UNIX socket the
runner already listens on. The pack's own two-service arrangement (`web/serve.js`
proxying `/api`) is what `docker compose up` runs and what phase 5 teaches; it is
the documented fallback, not what runs here.

What bounds a session, all of it configurable:

    PREVIEW_SESSIONS         how many live at once            2 (1 on a laptop)
    PREVIEW_IDLE_SECONDS     no request and no poll           300
    PREVIEW_MAX_SECONDS      whatever happens                 600
    PREVIEW_BOOT_SECONDS     the readiness budget              45
    PREVIEW_BUILD_SECONDS    the bundle                        30
    PREVIEW_MEMORY_MB        per session                      512
    PREVIEW_MAX_BYTES        served per session          33554432
    PREVIEW_REQUEST_TIMEOUT_MS  one proxied request           20000

Every one of those is enforced by `sweep_once` in this process, which is exactly
the problem when this process is killed rather than shut down: the child is
reparented to init, blocks in accept() spending no CPU so RLIMIT_CPU never fires
either, and lives until the machine is rebooted. So `start` also hands the child
`LSDLC_PREVIEW_SECONDS` (the hard cap plus a grace) and PREVIEW_BOOTSTRAP arms
it inside the child. The grace is what keeps the ordinary case unchanged: the
sweep still stops a supervised session first and still reports `expired`.

The port is never returned to anyone. A caller reaches the app through `proxy`
and `asset`, which is what keeps the browser on the API's origin and the
learner's app off the network.
"""

import base64
import binascii
import http.client
import mimetypes
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from datetime import datetime, timezone

from sandbox_runner import (
    CHILD_PATH,
    PREBAKE_MISSING_MESSAGE,
    PREVIEW_DEADLINE_ENV,
    PREVIEW_DEADLINE_GRACE_SECONDS,
    fenced_run,
    preview_argv,
    reap_group,
    redact_workspace,
    run_child,
    runtime_esbuild,
    runtime_node_modules,
    safe_join,
    spawn_child,
    write_job_files,
    isolation_status,
    ISOLATION_UNAVAILABLE,
)

# ----------------------------- the sentences -------------------------------
#
# The runner writes only the sentences it is the one that knows: what the
# learner's own process did. The stop reasons (idle,
# expired, budget, learner) come back as `stopReason` and the web's copy.ts
# turns them into words, because that is where the rest of the panel's copy
# lives and one sentence should not have two homes.

DID_NOT_START = "Your API did not start."
DID_NOT_ANSWER = "Your API did not answer in time."
STOPPED_ON_ITS_OWN = "Your API stopped."
BUNDLE_FAILED = "The front end did not build. The console has the compiler's message."
OUT_OF_TIME = "The app used up its time."

#: What `/app/asset` serves when there is no bundle to serve. Status 200 on
#: purpose: the panel is not broken, the learner's build is, and a 500 here
#: would light up the frame with a browser error page instead of a sentence.
BUILT_IN_PAGE = (
    "<!doctype html>\n"
    '<html lang="en"><head><meta charset="utf-8">'
    "<title>Preview</title>"
    "<style>body{margin:0;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;"
    "background:#faf8f4;color:#1c1b19;padding:48px 32px}"
    "p{max-width:44ch}</style></head>"
    "<body><p>" + BUNDLE_FAILED + "</p></body></html>\n"
)

# ------------------------------- the budgets --------------------------------

#: 400 lines, each 400 characters. A ring rather than a list because a chatty
#: app logs a line per request and a preview lives ten minutes.
CONSOLE_LINES = 400
CONSOLE_LINE_CHARS = 400

#: How long a stopped session's last words stay readable. The panel polls every
#: 15 seconds while a session is ready, so a minute is comfortably enough for
#: the poll after the stop to carry the reason and the console.
REMEMBER_SECONDS = 60

#: One proxied request body and one asset. Both are what a browser will hold in
#: memory anyway; the session's real bound is PREVIEW_MAX_BYTES.
MAX_PROXY_BYTES = 4 * 1024 * 1024
MAX_ASSET_BYTES = 8 * 1024 * 1024

#: An environment variable name a pack may set. The loader checks this too; the
#: runner is the trust boundary, so it checks it again.
ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,31}$")

#: The colour a terminal understands and a console pane does not.
#:
#: Flask paints its startup banner and Werkzeug paints its access log with ANSI
#: escapes, and the pane that shows them is HTML: left in, "\x1b[31mWARNING"
#: reaches the learner as the literal text "[31mWARNING". Stripped here, where
#: the line is captured, so every reader of the ring gets the same clean line
#: and nobody has to remember to strip it twice. Colour, cursor moves and the
#: OSC title sequences an app may write, and nothing else: the text itself is
#: the learner's own and is never rewritten.
ANSI = re.compile(
    r"\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])"
)


def note(line):
    """One line to the runner's log, and never a reason to stop.

    The API can start the runner as a child of its own with a pipe for stderr
    (RUNNER_MODE=local, the live preview). When that parent goes away the other
    end of the pipe goes with it, and every write here then raises
    BrokenPipeError. Let through, that turns the runner into a process that is
    alive, bound and useless: it kills a request thread mid-request, the thread
    that was about to stop the runner for being idle, or the preview sweep.
    Whoever is or is not reading the log, the runner has work to do.
    """
    try:
        sys.stderr.write(line if line.endswith("\n") else line + "\n")
        sys.stderr.flush()
    except (BrokenPipeError, OSError, ValueError):
        pass


def positive_int(raw, fallback):
    """A positive integer from the environment, or the default. Never raises."""
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError, AttributeError):
        return fallback
    return value if value > 0 else fallback


def limits(env=None):
    """Every bound, read fresh so a test can patch one and a deployment can set one."""
    env = os.environ if env is None else env
    return {
        "sessions": positive_int(env.get("PREVIEW_SESSIONS"), 2),
        "idle": positive_int(env.get("PREVIEW_IDLE_SECONDS"), 300),
        "max": positive_int(env.get("PREVIEW_MAX_SECONDS"), 600),
        "boot": positive_int(env.get("PREVIEW_BOOT_SECONDS"), 45),
        "build": positive_int(env.get("PREVIEW_BUILD_SECONDS"), 30),
        "memoryMb": positive_int(env.get("PREVIEW_MEMORY_MB"), 512),
        "maxBytes": positive_int(env.get("PREVIEW_MAX_BYTES"), 33554432),
        "requestTimeoutMs": positive_int(env.get("PREVIEW_REQUEST_TIMEOUT_MS"), 20000),
    }


class UnknownSession(Exception):
    """No session by that id, or one the runner has already forgotten."""


class SessionNotReady(Exception):
    """The session exists but is not serving. Carries its status, so the caller can say why."""

    def __init__(self, status, message=None):
        super().__init__(f"the app is {status}")
        self.status = status
        self.message = message


class SessionsFull(Exception):
    """Every preview slot on this runner is taken."""

    reason = "sessions-full"


def _now():
    return time.time()


def _iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="milliseconds")


class PreviewSession:
    """One learner's running application, and everything that bounds it."""

    def __init__(self, job, bounds):
        self.id = secrets.token_hex(8)
        self.bounds = bounds
        self.job = job
        self.workspace = None
        self._root_cache = None
        self.proc = None
        self.launch_finished = False
        self.cleanup_confirmed = False
        self._cleanup_lock = threading.Lock()
        self.port = None
        self.status = "starting"
        self.message = None
        self.stop_reason = None
        self.bundle_ok = True
        self.started_at = _now()
        self.ready_at = None
        self.expires_at = self.started_at + bounds["max"]
        self.last_seen_at = self.started_at
        self.bytes_served = 0
        self.stopped_at = None
        self._console = deque(maxlen=CONSOLE_LINES)
        self._console_total = 0
        self._readers = []
        self._lock = threading.Lock()

    # ------------------------------ the console -----------------------------

    def log(self, stream, text):
        """One line into the ring, stripped, truncated and redacted before it
        is stored.

        Before, not on the way out: a line that is never stored cannot leak from
        a second reader that forgets to redact, and the host's temp directory is
        in every traceback a Python app prints.
        """
        for line in str(text).splitlines() or [""]:
            # Before the truncation, so a banner's escapes do not spend the
            # line's 400 characters on colour the pane cannot draw anyway.
            line = ANSI.sub("", line)[:CONSOLE_LINE_CHARS]
            if self.workspace:
                line = redact_workspace(line, self._roots())
            with self._lock:
                self._console.append(
                    {"stream": stream, "text": line, "at": _iso(_now())}
                )
                self._console_total += 1

    def _roots(self):
        """Both spellings of the workspace, longest first, computed once.

        Once, because this is on the path of every console line a chatty app
        writes, and realpath is a syscall. Both spellings because the child's cwd
        is the resolved path while anything built from `workspace` here keeps the
        symlinked one, and /var is a symlink on macOS.
        """
        if self._root_cache is None and self.workspace:
            self._root_cache = sorted(
                {self.workspace, os.path.realpath(self.workspace)}, key=len, reverse=True
            )
        return self._root_cache or []

    def console_from(self, cursor):
        """The lines after `cursor`, and the cursor to send next time.

        The cursor counts lines ever written, not lines still held, so a client
        that was away while the ring wrapped gets what is left rather than an
        exception or a replay of everything.
        """
        with self._lock:
            total = self._console_total
            held = len(self._console)
            first = total - held
            try:
                start = max(0, int(cursor) - first)
            except (TypeError, ValueError):
                start = 0
            lines = list(self._console)[start:]
        return lines, total

    # ------------------------------- the view -------------------------------

    def view(self, cursor=None):
        answer = {
            "id": self.id,
            "status": self.status,
            "message": self.message,
            "stopReason": self.stop_reason,
            "bundleOk": self.bundle_ok,
            "startedAt": _iso(self.started_at),
            "readyAt": _iso(self.ready_at) if self.ready_at else None,
            "expiresAt": _iso(self.expires_at),
            "idleExpiresAt": _iso(self.last_seen_at + self.bounds["idle"]),
            "bytesServed": self.bytes_served,
            "cleanupConfirmed": self.cleanup_confirmed,
        }
        lines, total = self.console_from(0 if cursor is None else cursor)
        answer["console"] = lines
        answer["cursor"] = total
        return answer

    def touch(self):
        """Every proxied request and every status poll pushes the idle cap out."""
        self.last_seen_at = _now()


# --------------------------- the session register ---------------------------

SESSIONS = {}
_REGISTER_LOCK = threading.RLock()
_SWEEPER = None


def stats():
    with _REGISTER_LOCK:
        live = sum(1 for s in SESSIONS.values() if not s.cleanup_confirmed)
    return {"sessions": live, "max": limits()["sessions"]}


def _get(session_id):
    with _REGISTER_LOCK:
        session = SESSIONS.get(session_id)
    if session is None:
        raise UnknownSession(f"no preview session {session_id}")
    return session


# ------------------------------- starting -----------------------------------


def _check_env(env):
    """A pack's own environment, checked here as well as in the loader."""
    extra = {}
    for key, value in (env or {}).items():
        if not ENV_NAME.match(str(key)):
            raise ValueError(f"illegal environment name in preview: {key}")
        if not isinstance(value, str):
            raise ValueError(f"the preview environment value for {key} is not a string")
        extra[key] = value
    return extra


def _free_port():
    """A port the kernel picked, closed again before the child binds it.

    The window between closing and binding is a real race and there is no way to
    close it without holding the socket open in this process and handing the
    child a file descriptor, which is a bigger moving part than the race is
    worth: one learner, one child, on loopback.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]
    finally:
        sock.close()


def _bundle(session, build, seconds):
    """esbuild the front end into the pack's outfile. A failure is not fatal.

    The learner is previewing an application whose API may be the half that
    works; a broken bundle leaves them the API and a sentence rather than
    nothing at all. `bundleOk: false` is what the panel reads.
    """
    esbuild = runtime_esbuild()
    if esbuild is None:
        session.bundle_ok = False
        session.log("err", PREBAKE_MISSING_MESSAGE)
        return
    entry = build.get("entry")
    outfile = build.get("outfile")
    if not entry or not outfile:
        raise ValueError("the preview build needs an entry and an outfile")
    # safe_join, so a build block cannot write outside the workspace.
    safe_join(session.workspace, entry)
    out = safe_join(session.workspace, outfile)
    os.makedirs(os.path.dirname(out) or session.workspace, exist_ok=True)
    argv = [
        esbuild, os.path.normpath(entry),
        "--bundle", "--format=iife", "--platform=browser", "--target=es2020",
        f"--jsx={build.get('jsx', 'automatic')}",
        f"--outfile={os.path.normpath(outfile)}",
        # Linked, not inline. An inline map makes this bundle 4.2 MB against a
        # 32 MB session budget, so eight refreshes
        # would end the session; linked leaves the same debugging available and
        # costs the bytes only when a learner opens devtools.
        "--sourcemap", "--log-level=warning", "--color=false",
    ]
    env = {"PATH": CHILD_PATH, "HOME": session.workspace}
    node_modules = runtime_node_modules()
    if node_modules:
        # How esbuild finds react without a node_modules in the workspace. The
        # CLI reads NODE_PATH exactly as the JS API's nodePaths does.
        env["NODE_PATH"] = node_modules
    try:
        # Behind the kernel fence like the transform in execute_job: a bundle
        # that resolved an import from a sibling workspace would carry that
        # learner's file to this one's browser.
        proc = fenced_run(
            argv, session.workspace, programs=(esbuild,), capture_output=True, text=True,
            encoding="utf-8", errors="replace", env=env, timeout=seconds,
        )
    except subprocess.TimeoutExpired:
        session.bundle_ok = False
        session.log("err", f"The front end did not build in {seconds} seconds.")
        return
    if proc.returncode:
        session.bundle_ok = False
        session.log("err", proc.stderr or proc.stdout or "esbuild failed")
        return
    if proc.stderr:
        session.log("err", proc.stderr)


def _seed(session, command, extra_env):
    """Run the pack's seeder, so the app has something to show. Never fatal."""
    code, stdout, stderr, kind = run_child(
        preview_argv(command),
        session.workspace,
        20,
        session.bounds["memoryMb"],
        extra_env=extra_env,
        nofile=256,
    )
    if stdout:
        session.log("out", stdout)
    if stderr:
        session.log("err", stderr)
    if kind != "ok" or code != 0:
        # The app still starts: an empty database is a working application with
        # nothing in it, which is a much better preview than no preview.
        session.log("err", "The seed did not finish, so the app may have no data in it.")


def _drain(session, stream, name):
    for line in iter(stream.readline, ""):
        session.log(name, line.rstrip("\n"))
    try:
        stream.close()
    except OSError:
        pass


def _probe_ready(session):
    """Poll the learner's own health route until it answers, the child dies, or time runs out."""
    deadline = _now() + session.bounds["boot"]
    health = session.job.get("service", {}).get("health", "/")
    while _now() < deadline:
        if session.proc.poll() is not None:
            _finish(session, "failed", message=DID_NOT_START, reason="crashed")
            return
        try:
            conn = http.client.HTTPConnection("127.0.0.1", session.port, timeout=2)
            conn.request("GET", health)
            response = conn.getresponse()
            response.read()
            conn.close()
        except OSError:
            time.sleep(0.25)
            continue
        if response.status < 500:
            with _REGISTER_LOCK:
                if session.status == "starting":
                    session.status = "ready"
                    session.ready_at = _now()
                    session.touch()
            return
        time.sleep(0.25)
    _finish(session, "failed", message=DID_NOT_ANSWER, reason="crashed")


def start(job):
    """Build, seed and start one preview. Returns as soon as the child is up.

    Everything after the spawn (draining the child's output, waiting for its
    health route) happens on a background thread, so this call is short and the
    pool slot serve.py holds around it is released before the app is even ready
    (a slot held for ten minutes would starve a class of thirty).
    """
    if isolation_status()["status"] != "ok":
        return {"id": "", "status": "unavailable", "message": ISOLATION_UNAVAILABLE}
    if job.get("gradedFiles"):
        # App mode never seals, so it never receives: the graded artefacts would
        # simply be sitting in the workspace of a server the learner can read
        # through their own browser.
        raise ValueError("gradedFiles is not supported by mode=preview")

    bounds = limits()
    service = job.get("service") or {}
    command = service.get("command") or []
    # Raises before a session slot is taken if the command is not one we run.
    argv = preview_argv(command)
    port_env = service.get("portEnv") or "PORT"
    if not ENV_NAME.match(port_env):
        raise ValueError(f"illegal portEnv: {port_env}")
    extra_env = _check_env(job.get("env"))

    session = PreviewSession(job, bounds)
    with _REGISTER_LOCK:
        live = sum(1 for s in SESSIONS.values() if not s.cleanup_confirmed)
        if live >= bounds["sessions"]:
            raise SessionsFull(f"{live} preview sessions are already running")
        SESSIONS[session.id] = session

    try:
        session.workspace = tempfile.mkdtemp(prefix="lsdlc-app-")
        write_job_files(session.workspace, job.get("files") or {})
        build = job.get("build")
        if build:
            _bundle(session, build, bounds["build"])
        session.port = _free_port()
        child_env = dict(extra_env)
        child_env[port_env] = str(session.port)
        # The child's own deadline, set after the pack's environment so a pack
        # cannot lengthen it or take it away. It is the hard cap plus a grace:
        # the sweeper below normally stops a session first and reports
        # `expired`, and this only fires when the supervisor is gone; without
        # it, a runner killed rather than shut down would leave the learner's
        # app running under init until the machine is rebooted.
        child_env[PREVIEW_DEADLINE_ENV] = str(
            bounds["max"] + PREVIEW_DEADLINE_GRACE_SECONDS
        )
        seed = job.get("seed")
        if seed:
            _seed(session, seed, child_env)
        # Stop/expiry can race a long build/seed. Cancellation must fence the
        # eventual spawn, not just remove the workspace while it is in use.
        with _REGISTER_LOCK:
            if session.status != "starting":
                raise RuntimeError("preview launch cancelled")
            session.proc = spawn_child(
                argv,
                session.workspace,
                job.get("memoryMb") or bounds["memoryMb"],
                # A server lives until its existing preview deadline.
                bounds["max"],
                extra_env=child_env,
                nofile=512,
            )
            session.launch_finished = True
    except Exception as err:  # noqa: BLE001 (a half-started session must not be left live)
        session.launch_finished = True
        session.log("err", f"{type(err).__name__}: {err}")
        _finish(session, "failed", message=DID_NOT_START, reason="crashed")
        raise

    for stream, name in ((session.proc.stdout, "out"), (session.proc.stderr, "err")):
        thread = threading.Thread(target=_drain, args=(session, stream, name), daemon=True)
        thread.start()
        session._readers.append(thread)
    threading.Thread(target=_probe_ready, args=(session,), daemon=True).start()
    start_sweeper()
    return session.view(cursor=0)


# ------------------------------- stopping -----------------------------------

#: How long a stop waits, once the leader is reaped, for the rest of its group
#: to be gone. A killed worker can still answer for a moment while init
#: collects it; without this short wait the stop would answer unconfirmed, the
#: API would keep the seat, and the learner's Rebuild would be refused until
#: the next sweep (SWEEP_INTERVAL_SECONDS) asked again. Bounded: past it the
#: stop still answers unconfirmed, and the sweep goes on asking.
GROUP_GONE_SECONDS = 1.5
GROUP_POLL_SECONDS = 0.05


def _group_gone(pgid, within):
    """True once no process answers in group `pgid`, asked for `within` seconds.

    Only signal 0 is sent: the group was already killed by `reap_group`, and
    this asks whether it is gone, it does not kill again. EPERM (macOS, while
    uncollected zombies are all that is left) is not proof, so it waits on.
    """
    deadline = time.monotonic() + within
    while True:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return True
        except OSError:
            pass
        if time.monotonic() >= deadline:
            return False
        time.sleep(GROUP_POLL_SECONDS)


def _finish(session, status, message=None, reason=None):
    """Kill the child, keep the last words, throw the workspace away."""
    with _REGISTER_LOCK:
        if session.cleanup_confirmed:
            return session.view()
        if session.status not in ("stopped", "failed"):
            session.status = status
            session.message = message
            session.stop_reason = reason
            session.stopped_at = _now()
        if not session.launch_finished:
            return session.view()
    with session._cleanup_lock:
        if session.proc is not None:
            reap_group(session.proc.pid, group_id=session.proc.pid)
            try:
                session.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                return session.view()
            # setsid makes the known child PID its exact group ID. An exited
            # parent alone does not prove its worker processes are gone.
            if not _group_gone(session.proc.pid, GROUP_GONE_SECONDS):
                return session.view()
        for thread in session._readers:
            thread.join(timeout=2)
        if session.workspace:
            shutil.rmtree(session.workspace, ignore_errors=True)
        session.cleanup_confirmed = not session.workspace or not os.path.exists(session.workspace)
    return session.view()


def stop(session_id, reason="learner"):
    session = _get(session_id)
    view = _finish(session, "stopped", reason=reason)
    return view


def stop_all(reason="shutdown"):
    """Every live session, on shutdown. A preview must never outlive the runner."""
    with _REGISTER_LOCK:
        live = [s for s in SESSIONS.values() if not s.cleanup_confirmed]
    for session in live:
        _finish(session, "stopped", reason=reason)
    return len(live)


# ------------------------------- the status ---------------------------------


def status(session_id, cursor=0):
    session = _get(session_id)
    if session.status in ("starting", "ready"):
        # A poll counts as use: "idle" has to mean the tab is closed or hidden,
        # not "the learner is reading the screen".
        session.touch()
    return session.view(cursor=cursor)


# -------------------------------- serving -----------------------------------

#: Headers a proxied request may carry. Cookies and Authorization are dropped:
#: the frame is opaque-origin and the learner's app has no business seeing the
#: platform's credentials even if a browser were somehow persuaded to send them.
FORWARDED_HEADERS = ("content-type", "accept", "content-length")


def _serving(session):
    if session.status != "ready":
        raise SessionNotReady(session.status, session.message)
    return session


def _spend(session, count):
    """Count bytes against the session budget and stop it when it is spent."""
    session.bytes_served += count
    if session.bytes_served > session.bounds["maxBytes"]:
        _finish(session, "stopped", reason="budget")


def proxy(session_id, method, path, headers=None, body=None):
    """One request from the learner's browser to the learner's own API."""
    session = _serving(_get(session_id))
    session.touch()
    payload = b""
    if body:
        try:
            payload = base64.b64decode(body)
        except (binascii.Error, ValueError):
            raise ValueError("the proxied body is not base64")
    forwarded = {
        key: value
        for key, value in (headers or {}).items()
        if str(key).lower() in FORWARDED_HEADERS
    }
    timeout = session.bounds["requestTimeoutMs"] / 1000.0
    conn = http.client.HTTPConnection("127.0.0.1", session.port, timeout=timeout)
    try:
        conn.request(method or "GET", path or "/", body=payload or None, headers=forwarded)
        response = conn.getresponse()
        raw = response.read(MAX_PROXY_BYTES + 1)
        answer_headers = {
            key: value
            for key, value in response.getheaders()
            # A preview runs in a sandboxed frame with no same-origin, so a
            # cookie could not be stored anyway; stripping it here means the
            # API's own door never has to think about it.
            if key.lower() != "set-cookie"
        }
        status_code = response.status
    except (OSError, http.client.HTTPException) as err:
        # The app died mid-request, or is wedged. 502 rather than an exception:
        # the panel shows the app's own failure and the console has the reason.
        session.log("err", f"{type(err).__name__}: {err}")
        return {
            "status": 502,
            "headers": {"content-type": "text/plain; charset=utf-8"},
            "body": base64.b64encode(
                redact_workspace(str(err), session._roots()).encode("utf-8")
            ).decode("ascii"),
            "truncated": False,
        }
    finally:
        conn.close()
    truncated = len(raw) > MAX_PROXY_BYTES
    if truncated:
        raw = raw[:MAX_PROXY_BYTES]
    _spend(session, len(raw))
    return {
        "status": status_code,
        "headers": answer_headers,
        "body": base64.b64encode(raw).decode("ascii"),
        "truncated": truncated,
    }


def _content_type(path):
    guess, _encoding = mimetypes.guess_type(path)
    if path.endswith(".js") or path.endswith(".mjs"):
        return "text/javascript; charset=utf-8"
    if path.endswith(".map"):
        return "application/json; charset=utf-8"
    if guess is None:
        return "application/octet-stream"
    if guess.startswith("text/") or guess in ("application/json",):
        return f"{guess}; charset=utf-8"
    return guess


def _built_in_page():
    return {
        "status": 200,
        "contentType": "text/html; charset=utf-8",
        "body": base64.b64encode(BUILT_IN_PAGE.encode("utf-8")).decode("ascii"),
    }


def asset(session_id, path):
    """One file out of the learner's built front end.

    The rules, in order: an empty or unknown extensionless path is the app's own
    HTML (the front end uses hash routes, so `/` is every route), anything else
    is a file under the pack's `web.root`, and any path that would leave that
    directory is refused rather than answered.
    """
    session = _serving(_get(session_id))
    session.touch()
    web = session.job.get("web") or {}
    root = web.get("root") or "."
    html = web.get("html")
    rel = (path or "/").split("?")[0].split("#")[0].lstrip("/")

    def html_answer():
        if not html or not session.bundle_ok:
            return _built_in_page()
        try:
            source = safe_join(session.workspace, html)
        except ValueError:
            return _built_in_page()
        if not os.path.isfile(source):
            return _built_in_page()
        with open(source, "rb") as fh:
            body = fh.read(MAX_ASSET_BYTES)
        _spend(session, len(body))
        return {
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "body": base64.b64encode(body).decode("ascii"),
        }

    if not rel:
        return html_answer()
    try:
        target = safe_join(safe_join(session.workspace, root), rel)
    except ValueError:
        # ../../etc/passwd, an absolute path: refused, not answered, and not a
        # 404 either: the caller asked for something it may not have.
        return {"status": 403, "contentType": "text/plain; charset=utf-8",
                "body": base64.b64encode(b"forbidden").decode("ascii")}
    if os.path.isfile(target):
        with open(target, "rb") as fh:
            body = fh.read(MAX_ASSET_BYTES)
        _spend(session, len(body))
        return {
            "status": 200,
            "contentType": _content_type(target),
            "body": base64.b64encode(body).decode("ascii"),
        }
    if "." not in os.path.basename(rel):
        # A route, not a file: /tasks under a router that has not been told the
        # difference. The front end's own hash routes never come here, but a
        # learner typing a path should still see their app.
        return html_answer()
    return {"status": 404, "contentType": "text/plain; charset=utf-8",
            "body": base64.b64encode(b"not found").decode("ascii")}


# --------------------------------- the sweep --------------------------------


def sweep_once(now=None):
    """One tick: stop what is over a cap, forget what has been stopped a while.

    Returns the reasons it acted on, which is what the tests assert and what an
    operator reading the runner's log sees.
    """
    now = _now() if now is None else now
    acted = []
    with _REGISTER_LOCK:
        sessions = list(SESSIONS.values())
    for session in sessions:
        if session.status in ("starting", "ready"):
            if now > session.expires_at:
                _finish(session, "stopped", reason="expired")
                acted.append((session.id, "expired"))
            elif now > session.last_seen_at + session.bounds["idle"]:
                _finish(session, "stopped", reason="idle")
                acted.append((session.id, "idle"))
            elif session.bytes_served > session.bounds["maxBytes"]:
                _finish(session, "stopped", reason="budget")
                acted.append((session.id, "budget"))
            elif session.proc is not None and session.proc.poll() is not None:
                # It exited on its own. The console already has whatever it said
                # on the way out, except when the kernel killed it for spending
                # the CPU cap, which prints nothing at all and would otherwise
                # read as "your API stopped" for no visible reason.
                spun = session.proc.returncode == -signal.SIGXCPU
                _finish(
                    session, "failed",
                    message=(OUT_OF_TIME if spun else
                             DID_NOT_START if session.ready_at is None else STOPPED_ON_ITS_OWN),
                    reason="crashed",
                )
                acted.append((session.id, "crashed"))
        elif not session.cleanup_confirmed:
            _finish(session, session.status)
        elif session.stopped_at and now > session.stopped_at + REMEMBER_SECONDS:
            with _REGISTER_LOCK:
                SESSIONS.pop(session.id, None)
            acted.append((session.id, "forgotten"))
    return acted


#: How often the sweep runs: the tick that enforces the idle, hard and byte
#: caps and notices an app that stopped on its own.
SWEEP_INTERVAL_SECONDS = 5


def _sweep_forever(interval):
    while True:
        time.sleep(interval)
        try:
            sweep_once()
        except Exception as error:  # noqa: BLE001
            # The tick goes on: a sweeper thread that died would leave every
            # later session's children running past their caps. The log line
            # is how an operator learns that sweeps are failing.
            note(f"runner: preview sweep failed: {type(error).__name__}: {error}")


def start_sweeper(interval=SWEEP_INTERVAL_SECONDS):
    """The sweep's tick, started once, on the first session of this process."""
    global _SWEEPER
    with _REGISTER_LOCK:
        if _SWEEPER is not None and _SWEEPER.is_alive():
            return _SWEEPER
        _SWEEPER = threading.Thread(
            target=_sweep_forever, args=(interval,), daemon=True, name="preview-sweep"
        )
        _SWEEPER.start()
        return _SWEEPER
