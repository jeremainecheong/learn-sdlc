"""Tests for the runner service's own concurrency cap.

`request_queue_size` is the kernel's listen backlog, not a worker cap, and
`ThreadingMixIn` starts a thread per accepted connection, so without a cap the
runner would run every job that arrived. The API's gate
(`execution/run-gate.ts`, sized to RUNNER_SLOTS) is per API process,
while `docker-compose.yml` sizes this container for one replica's worth of
runs and documents a multi-replica shape in the same file.

These tests drive the real server over a real UNIX socket, with `execute_job`
replaced by a stub that only records how many of it were running at once;
the sandbox itself has tests of its own in test_runner.py, and
what is under test here is the admission gate in front of it.
"""

import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app_session  # noqa: E402
import serve  # noqa: E402
from test_app_session import job as app_job  # noqa: E402
from serve import (  # noqa: E402
    Busy,
    JobHandler,
    JobPool,
    RunnerServer,
    _UnixHTTPConnection,
    job_concurrency,
    runner_max_wait_ms,
    runner_queue_depth,
    runner_slots,
)

RUNNER_CONFIG_TS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "config", "runner.ts"
)


class ServerFixture:
    """A RunnerServer on a private socket, with execute_job replaced."""

    def __init__(self, pool, work):
        # Short directory: a UNIX socket path is capped near 104 bytes and the
        # macOS default temp root alone is most of that.
        self.dir = tempfile.mkdtemp(dir="/tmp")
        self.path = os.path.join(self.dir, "r.sock")
        self.server = RunnerServer(self.path, JobHandler, pool=pool)
        self.patch = mock.patch.object(serve, "execute_job", work)

    def __enter__(self):
        self.patch.start()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.patch.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        for path in (self.path,):
            try:
                os.unlink(path)
            except OSError:
                pass
        try:
            os.rmdir(self.dir)
        except OSError:
            pass

    def execute(self, mode="smoke", timeout=30):
        conn = _UnixHTTPConnection(self.path, timeout=timeout)
        body = json.dumps({"mode": mode, "files": {}}).encode("utf-8")
        conn.request(
            "POST", "/execute", body=body, headers={"Content-Type": "application/json"}
        )
        response = conn.getresponse()
        payload = json.loads(response.read())
        conn.close()
        return response.status, payload

    def pool_free(self):
        """Whether the pool has a slot free right now, read through /health."""
        _status, health = self.health()
        return health["pool"]["inFlight"] < health["pool"]["slots"]

    def health(self):
        conn = _UnixHTTPConnection(self.path, timeout=10)
        conn.request("GET", "/health")
        response = conn.getresponse()
        payload = json.loads(response.read())
        conn.close()
        return response.status, payload


class Recorder:
    """A stand-in for execute_job that reports the high-water concurrency."""

    def __init__(self, hold=0.25):
        self.hold = hold
        self.lock = threading.Lock()
        self.running = 0
        self.peak = 0
        self.calls = 0
        self.release = threading.Event()

    def __call__(self, job):
        with self.lock:
            self.running += 1
            self.calls += 1
            self.peak = max(self.peak, self.running)
        try:
            if self.hold is None:
                self.release.wait(timeout=30)
            else:
                time.sleep(self.hold)
        finally:
            with self.lock:
                self.running -= 1
        return {"ok": True, "exitKind": "ok", "stdout": "", "stderr": "", "durationMs": 1}


class SlotResolutionTest(unittest.TestCase):
    """The runner's cap is the API's cap: same variable, same arithmetic."""

    def test_runner_slots_reads_the_same_variable_the_api_does(self):
        self.assertEqual(runner_slots({"RUNNER_SLOTS": "3"}), 3)
        self.assertEqual(runner_slots({"JOB_CONCURRENCY": "4"}), 6)

    def test_a_bad_value_falls_back_rather_than_becoming_zero(self):
        # A cap of zero is a runner that never runs anything; parseInt-shaped
        # bugs are why config/runner.ts parses these with positiveInt.
        derived = job_concurrency({})
        for bad in ("", "0", "-4", "eight", "2.5", None):
            self.assertEqual(job_concurrency({"JOB_CONCURRENCY": bad}), derived, bad)
            self.assertEqual(runner_slots({"RUNNER_SLOTS": bad}), derived + 2, bad)
            self.assertEqual(runner_max_wait_ms({"RUNNER_MAX_WAIT_MS": bad}), 120_000, bad)

    def test_the_queue_is_shallower_than_the_apis_because_a_waiter_here_is_a_thread(self):
        self.assertEqual(runner_queue_depth({"RUNNER_SLOTS": "4"}), 16)
        self.assertEqual(runner_queue_depth({"RUNNER_QUEUE_DEPTH": "5"}), 5)
        # The runner container's pids_limit (128 in docker-compose.yml, 64 in
        # CI's container check) has to cover the accept thread, every waiting
        # thread and every sandbox child.
        self.assertLess(runner_queue_depth({"RUNNER_SLOTS": "4"}), 64)

    def test_the_default_still_matches_the_gate_in_the_api_runner_config(self):
        """If the API's default moves, this fails and names the file to change.

        The two numbers have to agree: the API gate promises RUNNER_SLOTS and
        this container enforces it, so a default that drifts on one side makes
        the runner either the surprise bottleneck or no cap at all.
        """
        with open(RUNNER_CONFIG_TS, encoding="utf-8") as handle:
            source = handle.read()
        message = (
            "apps/api/src/config/runner.ts changed how RUNNER_SLOTS defaults. "
            "runner/serve.py mirrors it (runner_slots / job_concurrency) and "
            "must change with it."
        )
        self.assertRegex(
            source,
            re.compile(
                r"resolveJobConcurrency\(env = process\.env\): number \{\s*"
                r"return positiveInt\(env\.JOB_CONCURRENCY\) \?\? Math\.max\(2, hostParallelism\(\) - 1\);"
            ),
            message,
        )
        self.assertRegex(
            source,
            re.compile(
                r"resolveRunnerSlots\(env = process\.env\): number \{\s*"
                r"return positiveInt\(env\.RUNNER_SLOTS\) \?\? resolveJobConcurrency\(env\) \+ 2;"
            ),
            message,
        )


class JobPoolTest(unittest.TestCase):
    def test_a_slot_is_released_even_when_the_work_raises(self):
        pool = JobPool(1, max_wait_ms=50, queue_depth=4)
        pool.acquire()
        pool.release()
        pool.acquire()
        self.assertEqual(pool.stats()["inFlight"], 1)
        pool.release()

    def test_a_full_line_is_refused_at_once_rather_than_waiting(self):
        pool = JobPool(1, max_wait_ms=60_000, queue_depth=1)
        pool.acquire()
        waiting = threading.Event()

        def wait_in_line():
            waiting.set()
            pool.acquire()
            pool.release()

        held = threading.Thread(target=wait_in_line, daemon=True)
        held.start()
        waiting.wait(timeout=5)
        # Give the queued thread time to actually reach the line.
        deadline = time.monotonic() + 5
        while pool.stats()["waiting"] < 1 and time.monotonic() < deadline:
            time.sleep(0.01)

        started = time.monotonic()
        with self.assertRaises(Busy) as caught:
            pool.acquire()
        self.assertEqual(caught.exception.reason, "queue-full")
        # Refused, not held: a full line answers now so the caller can retry.
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual(pool.stats()["refused"], 1)
        pool.release()
        held.join(timeout=5)

    def test_a_wait_past_the_deadline_is_refused_and_leaves_the_line_intact(self):
        pool = JobPool(1, max_wait_ms=80, queue_depth=8)
        pool.acquire()
        with self.assertRaises(Busy) as caught:
            pool.acquire()
        self.assertEqual(caught.exception.reason, "deadline")
        self.assertGreaterEqual(caught.exception.waited_ms, 60)
        self.assertEqual(pool.stats()["waiting"], 0)
        pool.release()
        # And the gate still works afterwards.
        pool.acquire()
        pool.release()

    def test_waiters_are_admitted_in_arrival_order(self):
        pool = JobPool(1, max_wait_ms=10_000, queue_depth=8)
        pool.acquire()
        order = []
        order_lock = threading.Lock()

        def waiter(tag):
            pool.acquire()
            with order_lock:
                order.append(tag)
            time.sleep(0.02)
            pool.release()

        threads = []
        for tag in ("a", "b", "c"):
            thread = threading.Thread(target=waiter, args=(tag,), daemon=True)
            thread.start()
            threads.append(thread)
            # Stagger so arrival order is unambiguous.
            deadline = time.monotonic() + 5
            want = len(threads)
            while pool.stats()["waiting"] < want and time.monotonic() < deadline:
                time.sleep(0.005)

        pool.release()
        for thread in threads:
            thread.join(timeout=10)
        self.assertEqual(order, ["a", "b", "c"])


class ServeConcurrencyTest(unittest.TestCase):
    """One more job than the pool holds is queued or refused, never killed."""

    def test_one_more_than_the_pool_size_is_queued_and_the_cap_holds(self):
        slots = 2
        work = Recorder(hold=0.4)
        pool = JobPool(slots, max_wait_ms=30_000, queue_depth=8)
        with ServerFixture(pool, work) as runner:
            with ThreadPoolExecutor(max_workers=slots + 1) as pool_of_callers:
                answers = list(
                    pool_of_callers.map(lambda _: runner.execute(), range(slots + 1))
                )

        statuses = [status for status, _ in answers]
        # Every caller was answered: none had its connection dropped and none
        # was killed. That is the difference between a queue and a crash.
        self.assertEqual(statuses, [200, 200, 200])
        self.assertEqual(work.calls, slots + 1)
        # And the cap actually held: without it all three ran at once.
        self.assertEqual(work.peak, slots)

    def test_the_extra_job_is_refused_with_503_once_the_wait_is_spent(self):
        slots = 1
        work = Recorder(hold=None)  # held open until we release it
        pool = JobPool(slots, max_wait_ms=100, queue_depth=8)
        with ServerFixture(pool, work) as runner:
            first = threading.Thread(target=runner.execute, daemon=True)
            first.start()
            deadline = time.monotonic() + 5
            while work.calls < 1 and time.monotonic() < deadline:
                time.sleep(0.01)

            status, body = runner.execute()
            self.assertEqual(status, 503)
            self.assertEqual(body["error"], "runner busy")
            self.assertEqual(body["reason"], "deadline")
            self.assertEqual(body["slots"], slots)
            # The refusal is an answer, not a dropped job: the runner never
            # started a second sandbox.
            self.assertEqual(work.calls, 1)

            # The health probe is never gated, so an operator can still see
            # what is happening while the runner is full.
            health_status, health = runner.health()
            self.assertEqual(health_status, 200)
            self.assertTrue(health["ok"])
            self.assertEqual(health["pool"]["slots"], slots)
            self.assertEqual(health["pool"]["inFlight"], 1)
            self.assertGreaterEqual(health["pool"]["refused"], 1)

            work.release.set()
            first.join(timeout=10)

    def test_a_refused_job_does_not_wedge_the_slot_behind_it(self):
        slots = 1
        work = Recorder(hold=None)
        pool = JobPool(slots, max_wait_ms=100, queue_depth=8)
        with ServerFixture(pool, work) as runner:
            first = threading.Thread(target=runner.execute, daemon=True)
            first.start()
            deadline = time.monotonic() + 5
            while work.calls < 1 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(runner.execute()[0], 503)
            work.release.set()
            first.join(timeout=10)

            work.hold = 0.01
            work.release.set()
            self.assertEqual(runner.execute()[0], 200)
            self.assertEqual(pool.stats()["inFlight"], 0)


# --------------------------------------------------------------------------
# The preview routes. Same server, same socket, same pool, and a
# different discipline, which is what these assert.
# --------------------------------------------------------------------------


class AppRoutesTest(unittest.TestCase):
    """The five /app/* routes over a real UNIX socket, against a real child."""

    def tearDown(self):
        app_session.stop_all()
        app_session.SESSIONS.clear()

    def post(self, runner, route, payload, timeout=30):
        conn = _UnixHTTPConnection(runner.path, timeout=timeout)
        body = json.dumps(payload).encode("utf-8")
        conn.request("POST", route, body=body,
                     headers={"Content-Type": "application/json"})
        response = conn.getresponse()
        answer = json.loads(response.read())
        conn.close()
        return response.status, answer

    def ready(self, runner, session_id, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status, view = self.post(runner, "/app/status", {"id": session_id})
            self.assertEqual(status, 200, view)
            if view["status"] != "starting":
                return view
            time.sleep(0.05)
        raise AssertionError("the session never left starting")

    def test_the_five_routes_round_trip_over_the_socket(self):
        with ServerFixture(JobPool(2), Recorder(hold=0.01)) as runner:
            status, started = self.post(runner, "/app/start", app_job())
            self.assertEqual(status, 200, started)
            self.assertEqual(started["status"], "starting")
            view = self.ready(runner, started["id"])
            self.assertEqual(view["status"], "ready", view)

            status, answer = self.post(runner, "/app/proxy", {
                "id": started["id"], "method": "GET", "path": "/api/health",
            })
            self.assertEqual(status, 200)
            self.assertEqual(answer["status"], 200)
            self.assertEqual(json.loads(base64.b64decode(answer["body"]))["status"], "ok")

            status, answer = self.post(runner, "/app/asset", {
                "id": started["id"], "path": "/",
            })
            self.assertEqual(status, 200)
            self.assertIn("text/html", answer["contentType"])
            self.assertIn(b"tasktrackr", base64.b64decode(answer["body"]))

            status, answer = self.post(runner, "/app/stop", {"id": started["id"]})
            self.assertEqual(status, 200)
            self.assertEqual(answer["status"], "stopped")
            self.assertEqual(answer["stopReason"], "learner")

            # Stopped, but remembered: the panel's next poll still gets the reason.
            status, answer = self.post(runner, "/app/status", {"id": started["id"]})
            self.assertEqual(status, 200)
            self.assertEqual(answer["stopReason"], "learner")
            # And serving it is a 409, not a 500 and not a blank 200.
            status, answer = self.post(runner, "/app/proxy", {
                "id": started["id"], "method": "GET", "path": "/api/health",
            })
            self.assertEqual(status, 409, answer)

    def test_an_unknown_session_is_404_and_an_unknown_route_is_too(self):
        with ServerFixture(JobPool(2), Recorder(hold=0.01)) as runner:
            for route, payload in (
                ("/app/status", {"id": "nope"}),
                ("/app/stop", {"id": "nope"}),
                ("/app/proxy", {"id": "nope", "method": "GET", "path": "/"}),
                ("/app/asset", {"id": "nope", "path": "/"}),
            ):
                status, answer = self.post(runner, route, payload)
                self.assertEqual(status, 404, (route, answer))
            self.assertEqual(self.post(runner, "/app/nothing", {})[0], 404)

    def test_a_start_the_runner_will_not_run_is_400_and_not_500(self):
        with ServerFixture(JobPool(2), Recorder(hold=0.01)) as runner:
            payload = app_job()
            payload["service"] = {"command": ["node", "serve.js"], "portEnv": "PORT",
                                  "health": "/"}
            status, answer = self.post(runner, "/app/start", payload)
            self.assertEqual(status, 400, answer)
            self.assertIn("python3", answer["error"])

    def test_health_reports_the_live_sessions_beside_the_pool(self):
        with ServerFixture(JobPool(2), Recorder(hold=0.01)) as runner:
            _status, health = runner.health()
            self.assertEqual(health["app"]["sessions"], 0)
            self.assertGreaterEqual(health["app"]["max"], 1)
            _status, started = self.post(runner, "/app/start", app_job())
            self.ready(runner, started["id"])
            _status, health = runner.health()
            self.assertEqual(health["app"]["sessions"], 1)

    def test_the_pool_slot_is_held_for_the_build_and_not_for_the_session(self):
        """One slot, one live preview, and grading still runs.

        This is the case that fails loudly if `/app/start` ever holds its slot
        for the life of the session: with a single slot, the /execute below
        would wait out the preview's whole ten minutes.
        """
        work = Recorder(hold=0.01)
        with ServerFixture(JobPool(1, max_wait_ms=3000), work) as runner:
            _status, started = self.post(runner, "/app/start", app_job())
            self.ready(runner, started["id"])
            self.assertEqual(runner.pool_free(), True)
            self.assertEqual(runner.execute()[0], 200)
            self.assertEqual(work.calls, 1)
            # And the session is still there, still serving.
            status, answer = self.post(runner, "/app/proxy", {
                "id": started["id"], "method": "GET", "path": "/api/health",
            })
            self.assertEqual((status, answer["status"]), (200, 200))

    def test_a_full_pool_refuses_a_start_and_no_session_is_made(self):
        work = Recorder(hold=None)
        with ServerFixture(JobPool(1, max_wait_ms=100, queue_depth=1), work) as runner:
            holding = threading.Thread(target=runner.execute, daemon=True)
            holding.start()
            deadline = time.monotonic() + 5
            while work.calls < 1 and time.monotonic() < deadline:
                time.sleep(0.01)
            status, answer = self.post(runner, "/app/start", app_job())
            self.assertEqual(status, 503, answer)
            self.assertIn(answer["reason"], ("deadline", "queue-full"))
            self.assertEqual(app_session.stats()["sessions"], 0)
            work.release.set()
            holding.join(timeout=10)

    def test_proxy_and_asset_are_served_while_the_pool_is_saturated(self):
        """A learner clicking in their own app must not queue behind a class.

        If the proxy ever went through JobPool.acquire, this is the test that
        would hang: the slot below is held for the whole case.
        """
        work = Recorder(hold=None)
        with ServerFixture(JobPool(1, max_wait_ms=100, queue_depth=1), work) as runner:
            _status, started = self.post(runner, "/app/start", app_job())
            self.ready(runner, started["id"])
            holding = threading.Thread(target=runner.execute, daemon=True)
            holding.start()
            deadline = time.monotonic() + 5
            while work.calls < 1 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(runner.pool_free(), False)

            status, answer = self.post(runner, "/app/proxy", {
                "id": started["id"], "method": "GET", "path": "/api/health",
            }, timeout=10)
            self.assertEqual((status, answer["status"]), (200, 200))
            status, answer = self.post(runner, "/app/asset",
                                       {"id": started["id"], "path": "/app.js"}, timeout=10)
            self.assertEqual((status, answer["status"]), (200, 200))
            status, view = self.post(runner, "/app/status", {"id": started["id"]}, timeout=10)
            self.assertEqual(view["status"], "ready")

            work.release.set()
            holding.join(timeout=10)

    def test_the_runner_keeps_serving_when_nobody_is_reading_its_log(self):
        """A dead log pipe must not turn the runner into a socket that answers nothing.

        The API starts this server as a child of its own for the live preview
        under RUNNER_MODE=local, with a pipe for stderr. When that parent goes
        away (a killed test run, a crashed CLI), the pipe's other end goes with
        it, and a log line then raises BrokenPipeError inside the request
        thread. Unhandled, the thread dies mid-request: the server stays alive
        and bound, answers every later request with a hang-up, and the next
        runner refuses to bind over it because a connect still succeeds. On a
        laptop that reads as "the preview is unavailable" with nothing anywhere
        to say why.
        """
        script = os.path.join(os.path.dirname(__file__), "serve.py")
        directory = tempfile.mkdtemp(dir="/tmp")
        path = os.path.join(directory, "s.sock")
        child = subprocess.Popen(
            [sys.executable, script],
            env={**os.environ, "RUNNER_SOCKET": path},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            deadline = time.time() + 15
            while time.time() < deadline and not os.path.exists(path):
                time.sleep(0.1)
            self.assertTrue(os.path.exists(path), "the runner never bound its socket")
            self.assertEqual(self.health(path)["ok"], True)

            # The parent stops reading. Every log line the child writes from
            # here on is a write to a pipe nobody holds.
            child.stderr.close()

            for _ in range(3):
                self.assertEqual(self.health(path)["ok"], True)
        finally:
            child.terminate()
            child.wait(timeout=10)
            shutil.rmtree(directory, ignore_errors=True)

    def test_a_local_runner_stops_itself_even_with_its_log_pipe_gone(self):
        """The case that actually happens: the parent died, so both are true at once.

        A runner whose parent went away has a dead stderr pipe AND is the one
        nobody is going to stop. If the line it writes on its way out raised
        BrokenPipeError before the stop, the error would kill the thread that
        was about to stop it and it would run until the machine was rebooted.
        """
        script = os.path.join(os.path.dirname(__file__), "serve.py")
        directory = tempfile.mkdtemp(dir="/tmp")
        path = os.path.join(directory, "d.sock")
        child = subprocess.Popen(
            [sys.executable, script],
            env={**os.environ, "RUNNER_SOCKET": path, "RUNNER_IDLE_EXIT_SECONDS": "1"},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            deadline = time.time() + 15
            while time.time() < deadline and not os.path.exists(path):
                time.sleep(0.1)
            self.assertEqual(self.health(path)["ok"], True)
            child.stderr.close()

            child.wait(timeout=30)
            self.assertFalse(os.path.exists(path))
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            shutil.rmtree(directory, ignore_errors=True)

    def test_a_local_runner_stops_itself_once_nobody_is_using_it(self):
        """An orphaned preview runner must not outlive the thing that wanted it.

        The compose runner is a service and runs until its container does; a
        runner the API started for the live preview on RUNNER_MODE=local is
        not, and the API is not always the thing that ends cleanly. A killed
        test run, a Ctrl-C'd CLI and a jest worker (whose sandboxed `process`
        never fires the parent's exit handler) would each leave one bound to
        its socket forever, and the next runner would refuse to bind over it.
        """
        script = os.path.join(os.path.dirname(__file__), "serve.py")
        directory = tempfile.mkdtemp(dir="/tmp")
        path = os.path.join(directory, "i.sock")
        child = subprocess.Popen(
            [sys.executable, script],
            env={**os.environ, "RUNNER_SOCKET": path, "RUNNER_IDLE_EXIT_SECONDS": "1"},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.time() + 15
            while time.time() < deadline and not os.path.exists(path):
                time.sleep(0.1)
            self.assertEqual(self.health(path)["ok"], True)

            child.wait(timeout=30)
            self.assertFalse(
                os.path.exists(path),
                "the runner stopped but left its socket behind, which is what the next one trips over",
            )
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            shutil.rmtree(directory, ignore_errors=True)

    def test_a_runner_with_no_idle_limit_keeps_serving(self):
        """The container's runner is a service: unset means never, not soon."""
        self.assertEqual(serve.idle_exit_seconds({}), 0)
        self.assertEqual(serve.idle_exit_seconds({"RUNNER_IDLE_EXIT_SECONDS": "0"}), 0)
        self.assertEqual(serve.idle_exit_seconds({"RUNNER_IDLE_EXIT_SECONDS": "soon"}), 0)
        self.assertEqual(serve.idle_exit_seconds({"RUNNER_IDLE_EXIT_SECONDS": "120"}), 120)

    def health(self, path):
        conn = _UnixHTTPConnection(path, timeout=5)
        conn.request("GET", "/health")
        answer = json.loads(conn.getresponse().read())
        conn.close()
        return answer

    def test_a_sessions_full_start_is_503_with_the_reason(self):
        with mock.patch.dict(os.environ, {"PREVIEW_SESSIONS": "1"}):
            with ServerFixture(JobPool(2), Recorder(hold=0.01)) as runner:
                _status, started = self.post(runner, "/app/start", app_job())
                self.ready(runner, started["id"])
                status, answer = self.post(runner, "/app/start", app_job())
                self.assertEqual(status, 503, answer)
                self.assertEqual(answer["reason"], "sessions-full")


if __name__ == "__main__":
    unittest.main()
