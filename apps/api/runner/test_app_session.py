"""The live preview supervisor: what it starts, what it serves, what it stops.

Every test here starts a real child on a real loopback port and talks to it the
way the API will: through `proxy` and `asset`, never through the port, which is
the point of the design and so is asserted rather than assumed.

The application under test is a fifteen-line `http.server` rather than the
canonical Flask app, for one reason: a test that spawns a process per case has
to be fast, and what is under test is the supervisor. The Flask app itself is
proved to start under this sandbox in `test_preview_bootstrap.py`, and end to
end in the API's own e2e spec.
"""

import base64
import io
import json
import os
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app_session  # noqa: E402
import sandbox_runner  # noqa: E402
from app_session import (  # noqa: E402
    BUNDLE_FAILED,
    DID_NOT_START,
    SessionNotReady,
    SessionsFull,
    UnknownSession,
    asset,
    proxy,
    start,
    status,
    stop,
    stop_all,
    sweep_once,
)

# A whole application in twenty lines: a health route, an echo route that hands
# back exactly what it received, and two lines of output so the console has
# something to show.
APP = '''
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

print("tasktrackr listening", flush=True)
sys.stderr.write("a line on stderr\\n")
sys.stderr.write("cwd is " + os.getcwd() + "\\n")
sys.stderr.flush()


class Handler(BaseHTTPRequestHandler):
    def _echo(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Echo-Method", self.command)
        self.send_header("X-Echo-Path", self.path)
        self.send_header("X-Echo-Headers", json.dumps(sorted(k.lower() for k in self.headers)))
        self.send_header("Set-Cookie", "session=should-not-survive")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/health"):
            self._json({"status": "ok"})
        elif self.path.startswith("/api/env"):
            self._json(sorted(os.environ))
        elif self.path.startswith("/api/deadline"):
            self._json(os.environ.get("LSDLC_PREVIEW_SECONDS"))
        elif self.path.startswith("/api/big"):
            body = b"x" * 200000
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._echo()

    do_POST = _echo
    do_PATCH = _echo

    def log_message(self, fmt, *args):
        sys.stderr.write("request " + (fmt % args) + "\\n")


HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
'''

INDEX_HTML = '<!doctype html><html><body><div id="root" data-app="tasktrackr"></div>' \
             '<script src="app.js"></script></body></html>'
BUNDLE_JS = 'console.log("hello from the bundle");\n'


def job(files=None, **overrides):
    payload = {
        "mode": "preview",
        "files": {
            "app.py": APP,
            "web/index.html": INDEX_HTML,
            "web/dist/app.js": BUNDLE_JS,
            **(files or {}),
        },
        "service": {"command": ["python3", "app.py"], "portEnv": "PORT",
                    "health": "/api/health"},
        "web": {"root": "web/dist", "html": "web/index.html"},
    }
    payload.update(overrides)
    return payload


def wait_for(session_id, wanted=("ready", "failed", "stopped"), timeout=30):
    deadline = time.monotonic() + timeout
    view = status(session_id)
    while view["status"] not in wanted and time.monotonic() < deadline:
        time.sleep(0.05)
        view = status(session_id)
    return view


def settled(session_id, quiet=0.3, timeout=5):
    """Poll until the console stops growing, and return that view."""
    deadline = time.monotonic() + timeout
    view = status(session_id, cursor=0)
    while time.monotonic() < deadline:
        time.sleep(quiet)
        again = status(session_id, cursor=0)
        if again["cursor"] == view["cursor"]:
            return again
        view = again
    return view


def body_of(answer):
    return base64.b64decode(answer["body"])


class PreviewCase(unittest.TestCase):
    """Every case leaves the register empty, whatever it did to it."""

    def tearDown(self):
        stop_all()
        app_session.SESSIONS.clear()

    def started(self, payload=None, **kwargs):
        view = start(payload or job(**kwargs))
        self.addCleanup(lambda: stop(view["id"]) if view["id"] in app_session.SESSIONS else None)
        return view


class StartsTest(PreviewCase):
    def test_a_started_app_reaches_ready_and_answers_its_own_health_route(self):
        view = self.started()
        self.assertEqual(view["status"], "starting")
        ready = wait_for(view["id"])
        self.assertEqual(ready["status"], "ready", ready)
        answer = proxy(view["id"], "GET", "/api/health")
        self.assertEqual(answer["status"], 200)
        self.assertEqual(json.loads(body_of(answer))["status"], "ok")

    def test_the_port_is_never_returned(self):
        # The whole authorisation design rests on the browser never learning it.
        view = self.started()
        wait_for(view["id"])
        self.assertNotIn("port", json.dumps(view).lower())
        self.assertNotIn("port", json.dumps(status(view["id"])).lower())

    def test_graded_files_are_refused(self):
        with self.assertRaises(ValueError) as raised:
            start(job(gradedFiles={"tests/hidden.py": "x = 1"}))
        self.assertIn("gradedFiles", str(raised.exception))

    def test_a_second_session_past_the_cap_is_refused(self):
        with mock.patch.dict(os.environ, {"PREVIEW_SESSIONS": "1"}):
            first = self.started()
            wait_for(first["id"])
            with self.assertRaises(SessionsFull) as raised:
                start(job())
            self.assertEqual(raised.exception.reason, "sessions-full")
        # And the refusal did not leave a half-built session behind.
        self.assertEqual(len(app_session.SESSIONS), 1)

    def test_an_unknown_session_is_unknown_rather_than_a_crash(self):
        for call in (lambda: status("nope"), lambda: stop("nope"),
                     lambda: proxy("nope", "GET", "/"), lambda: asset("nope", "/")):
            with self.assertRaises(UnknownSession):
                call()


class ProxyTest(PreviewCase):
    @classmethod
    def setUpClass(cls):
        cls.view = start(job())
        wait_for(cls.view["id"])

    @classmethod
    def tearDownClass(cls):
        stop(cls.view["id"])
        app_session.SESSIONS.clear()

    def tearDown(self):
        pass  # the class owns the session

    def test_method_path_and_a_binary_body_all_survive(self):
        payload = bytes(range(256))
        answer = proxy(
            self.view["id"], "POST", "/api/tasks?limit=2",
            headers={"content-type": "application/octet-stream"},
            body=base64.b64encode(payload).decode(),
        )
        self.assertEqual(answer["status"], 200)
        self.assertEqual(body_of(answer), payload)
        self.assertEqual(answer["headers"]["X-Echo-Method"], "POST")
        self.assertEqual(answer["headers"]["X-Echo-Path"], "/api/tasks?limit=2")

    def test_a_cookie_and_an_authorization_header_never_reach_the_learners_app(self):
        answer = proxy(
            self.view["id"], "GET", "/api/tasks",
            headers={"cookie": "lsdlc=1", "authorization": "Bearer secret",
                     "accept": "application/json"},
        )
        seen = json.loads(answer["headers"]["X-Echo-Headers"])
        self.assertIn("accept", seen)
        self.assertNotIn("cookie", seen)
        self.assertNotIn("authorization", seen)

    def test_set_cookie_is_stripped_from_the_answer(self):
        answer = proxy(self.view["id"], "GET", "/api/tasks")
        self.assertNotIn("set-cookie", [k.lower() for k in answer["headers"]])

    def test_a_status_poll_carries_the_apps_output_on_both_streams(self):
        view = status(self.view["id"], cursor=0)
        text = " ".join(line["text"] for line in view["console"])
        self.assertIn("tasktrackr listening", text)
        self.assertIn("a line on stderr", text)
        self.assertIn("out", [line["stream"] for line in view["console"]])
        self.assertIn("err", [line["stream"] for line in view["console"]])

    def test_the_cursor_only_hands_back_what_is_new(self):
        # Settle first: the reader threads are draining a pipe, so a line an
        # earlier case's request wrote may still be in flight, and it would look
        # like the cursor handing back output it had already handed back.
        first = settled(self.view["id"])
        self.assertGreater(first["cursor"], 0)
        again = status(self.view["id"], cursor=first["cursor"])
        self.assertEqual(again["console"], [])
        proxy(self.view["id"], "GET", "/api/tasks")  # the app logs every request
        # And wait for it: the line is written by the app, read by a reader
        # thread and only then stored, so "immediately after the request" is a
        # race in the test rather than in the console.
        after = again
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not after["console"]:
            time.sleep(0.05)
            after = status(self.view["id"], cursor=first["cursor"])
        self.assertTrue(after["console"], "the app's own log line never arrived")
        self.assertGreater(after["cursor"], first["cursor"])

    def test_the_host_path_is_in_nothing_we_hand_back(self):
        # The app prints its own cwd, which is the host's temp directory.
        view = status(self.view["id"], cursor=0)
        session = app_session.SESSIONS[self.view["id"]]
        blob = json.dumps(view)
        self.assertIn("cwd is", blob)
        self.assertNotIn(session.workspace, blob)
        self.assertNotIn(os.path.realpath(session.workspace), blob)
        self.assertNotIn("lsdlc-app-", blob)

    def test_the_child_gets_the_allowlist_and_not_the_apis_secrets(self):
        answer = proxy(self.view["id"], "GET", "/api/env")
        names = json.loads(body_of(answer))
        self.assertIn("PORT", names)
        self.assertIn("TASKTRACKR_DB", names)
        self.assertNotIn("JWT_SECRET", names)
        self.assertNotIn("DATABASE_URL", names)

    def test_the_child_carries_its_own_deadline(self):
        # The sweep in this process is not the only thing that ends a session:
        # a runner that is killed rather than shut down leaves the learner's app
        # under init with nothing enforcing the hard cap. The child reads this
        # and stops itself, and it is longer than the cap so the sweep still
        # wins on a supervised session and still reports `expired`.
        answer = proxy(self.view["id"], "GET", "/api/deadline")
        seconds = json.loads(body_of(answer))
        self.assertIsNotNone(seconds, "the child was started with no deadline of its own")
        session = app_session.SESSIONS[self.view["id"]]
        self.assertEqual(
            int(seconds),
            session.bounds["max"] + sandbox_runner.PREVIEW_DEADLINE_GRACE_SECONDS,
        )
        self.assertGreater(int(seconds), session.bounds["max"])


class AssetTest(PreviewCase):
    def setUp(self):
        self.view = start(job())
        wait_for(self.view["id"])

    def test_the_root_is_the_packs_own_html(self):
        answer = asset(self.view["id"], "/")
        self.assertEqual(answer["status"], 200)
        self.assertIn("text/html", answer["contentType"])
        self.assertIn(b'data-app="tasktrackr"', body_of(answer))

    def test_a_bundle_is_served_as_javascript(self):
        answer = asset(self.view["id"], "/app.js")
        self.assertEqual(answer["status"], 200)
        self.assertIn("text/javascript", answer["contentType"])
        self.assertIn(b"hello from the bundle", body_of(answer))

    def test_an_unknown_extensionless_path_falls_back_to_the_html(self):
        # A learner who types /overdue into the address bar of the new tab.
        answer = asset(self.view["id"], "/overdue")
        self.assertEqual(answer["status"], 200)
        self.assertIn(b'data-app="tasktrackr"', body_of(answer))

    def test_a_missing_file_is_a_404_and_not_the_html(self):
        answer = asset(self.view["id"], "/missing.js")
        self.assertEqual(answer["status"], 404)

    def test_a_traversal_is_refused(self):
        for path in ("/../../etc/passwd", "/../app.py", "/a/../../../../etc/passwd"):
            answer = asset(self.view["id"], path)
            self.assertEqual(answer["status"], 403, path)
            self.assertNotIn(b"root:", body_of(answer))

    def test_nothing_outside_the_web_root_is_reachable(self):
        # app.py is in the workspace but not under web/dist.
        answer = asset(self.view["id"], "/app.py")
        self.assertNotEqual(answer["status"], 200)


class ConsoleTest(PreviewCase):
    NOISY = (
        "import sys\n"
        "for i in range(500):\n"
        "    print('line %d' % i, flush=True)\n"
        "print('x' * 5000, flush=True)\n"
        "import os\n"
        "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
        "class H(BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        self.send_response(200)\n"
        "        self.send_header('Content-Length', '2')\n"
        "        self.end_headers()\n"
        "        self.wfile.write(b'ok')\n"
        "    def log_message(self, *a):\n"
        "        pass\n"
        "HTTPServer(('127.0.0.1', int(os.environ['PORT'])), H).serve_forever()\n"
    )

    def test_the_console_is_line_split_truncated_and_ring_capped(self):
        view = self.started(job(files={"app.py": self.NOISY}))
        wait_for(view["id"])
        # The reader threads are draining a pipe; give them a moment to finish.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            lines = status(view["id"], cursor=0)["console"]
            if any(len(line["text"]) == app_session.CONSOLE_LINE_CHARS for line in lines):
                break
            time.sleep(0.05)
        answer = status(view["id"], cursor=0)
        self.assertLessEqual(len(answer["console"]), app_session.CONSOLE_LINES)
        self.assertGreater(answer["cursor"], app_session.CONSOLE_LINES)
        longest = max(len(line["text"]) for line in answer["console"])
        self.assertEqual(longest, app_session.CONSOLE_LINE_CHARS)
        self.assertTrue(all("\n" not in line["text"] for line in answer["console"]))


    COLOURED = (
        "import os, sys\n"
        # Flask's own banner and Werkzeug's access log, escapes and all.
        "sys.stderr.write('\\x1b[31m\\x1b[1mWARNING: This is a development server.\\x1b[0m\\n')\n"
        "sys.stderr.write('\\x1b[33mPress CTRL+C to quit\\x1b[0m\\n')\n"
        "sys.stderr.flush()\n"
        "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
        "class H(BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        self.send_response(200)\n"
        "        self.send_header('Content-Length', '2')\n"
        "        self.end_headers()\n"
        "        self.wfile.write(b'ok')\n"
        "    def log_message(self, *a):\n"
        "        pass\n"
        "HTTPServer(('127.0.0.1', int(os.environ['PORT'])), H).serve_forever()\n"
    )

    def test_the_console_keeps_the_words_and_drops_the_colour(self):
        """The pane is HTML: an escape left in reaches the learner as "[31m"."""
        view = self.started(job(files={"app.py": self.COLOURED}))
        wait_for(view["id"])
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            lines = status(view["id"], cursor=0)["console"]
            if any("CTRL+C" in line["text"] for line in lines):
                break
            time.sleep(0.05)
        texts = [line["text"] for line in status(view["id"], cursor=0)["console"]]
        self.assertIn("WARNING: This is a development server.", texts)
        self.assertIn("Press CTRL+C to quit", texts)
        self.assertTrue(all("\x1b" not in text for text in texts), texts)
        self.assertTrue(all("[31m" not in text and "[0m" not in text for text in texts), texts)


class FailureTest(PreviewCase):
    BROKEN = "import nosuchmodule\n"

    def test_an_app_that_dies_on_import_reaches_failed_with_its_traceback(self):
        view = self.started(job(files={"app.py": self.BROKEN}))
        final = wait_for(view["id"], wanted=("failed",))
        self.assertEqual(final["status"], "failed")
        self.assertEqual(final["message"], DID_NOT_START)
        text = " ".join(line["text"] for line in final["console"])
        self.assertIn("ModuleNotFoundError", text)
        self.assertNotIn("lsdlc-app-", json.dumps(final))

    def test_sweeper_reports_startup_failure_when_it_observes_exit_first(self):
        # Force the other valid scheduling order: no readiness probe runs before
        # the sweeper sees the real process exit. Classification must not depend
        # on which supervisor thread happens to win.
        with mock.patch.object(app_session, "_probe_ready"), mock.patch.object(app_session, "start_sweeper"):
            for _ in range(3):
                view = self.started(job(files={"app.py": self.BROKEN}))
                session = app_session.SESSIONS[view["id"]]
                session.proc.wait(timeout=10)
                sweep_once()
                final = status(view["id"], cursor=0)
                self.assertEqual(final["status"], "failed")
                self.assertEqual(final["message"], DID_NOT_START)
                self.assertIn("ModuleNotFoundError", " ".join(line["text"] for line in final["console"]))
                self.assertNotIn("lsdlc-app-", json.dumps(final))

    def test_an_app_that_never_answers_gives_up_inside_the_boot_budget(self):
        quiet = "import time\ntime.sleep(600)\n"
        with mock.patch.dict(os.environ, {"PREVIEW_BOOT_SECONDS": "2"}):
            view = self.started(job(files={"app.py": quiet}))
            started = time.monotonic()
            final = wait_for(view["id"], wanted=("failed",), timeout=20)
        self.assertEqual(final["status"], "failed")
        self.assertIn("did not answer", final["message"])
        self.assertLess(time.monotonic() - started, 15)


class BundleTest(PreviewCase):
    BROKEN_TSX = "export const x: number = ;\n"

    @unittest.skipIf(sandbox_runner.runtime_esbuild() is None,
                     "esbuild is not baked on this machine; run npm run prebake")
    def test_a_bundle_failure_leaves_the_session_up_and_serves_the_built_in_page(self):
        view = self.started(job(
            files={"web/src/main.tsx": self.BROKEN_TSX},
            build={"tool": "esbuild", "entry": "web/src/main.tsx",
                   "outfile": "web/dist/app.js", "jsx": "automatic"},
        ))
        ready = wait_for(view["id"])
        self.assertEqual(ready["status"], "ready", ready)
        self.assertFalse(ready["bundleOk"])
        page = asset(view["id"], "/")
        self.assertEqual(page["status"], 200)
        self.assertIn(BUNDLE_FAILED.encode(), body_of(page))
        text = " ".join(line["text"] for line in ready["console"])
        self.assertIn("ERROR", text.upper())

    @unittest.skipIf(sandbox_runner.runtime_esbuild() is None,
                     "esbuild is not baked on this machine; run npm run prebake")
    def test_a_bundle_that_builds_is_what_the_frame_gets(self):
        entry = "const root = document.getElementById('root');\n" \
                "if (root) root.textContent = 'built by esbuild';\n"
        view = self.started(job(
            files={"web/src/main.tsx": entry},
            build={"tool": "esbuild", "entry": "web/src/main.tsx",
                   "outfile": "web/dist/app.js", "jsx": "automatic"},
        ))
        ready = wait_for(view["id"])
        self.assertTrue(ready["bundleOk"], ready)
        answer = asset(view["id"], "/app.js")
        self.assertEqual(answer["status"], 200)
        self.assertIn(b"built by esbuild", body_of(answer))


class SweepTest(PreviewCase):
    def test_the_idle_cap_stops_a_session_and_serving_it_then_refuses(self):
        # The cap is minutes and the sweep under test is handed a clock past it,
        # rather than a short cap and a real sleep: `start()` arms a background
        # sweeper on the first session of the process (app_session.start_sweeper,
        # every 5 s), so a test that waits out a one-second cap in real time is
        # racing that thread for the right to stop the session, and loses
        # whenever the tick lands inside the wait.
        with mock.patch.dict(os.environ, {"PREVIEW_IDLE_SECONDS": "60"}):
            view = self.started()
            wait_for(view["id"])
            acted = sweep_once(now=time.time() + 61)
        self.assertIn((view["id"], "idle"), acted)
        final = status(view["id"])
        self.assertEqual(final["status"], "stopped")
        self.assertEqual(final["stopReason"], "idle")
        with self.assertRaises(SessionNotReady):
            proxy(view["id"], "GET", "/api/health")

    def test_a_status_poll_counts_as_use(self):
        with mock.patch.dict(os.environ, {"PREVIEW_IDLE_SECONDS": "2"}):
            view = self.started()
            wait_for(view["id"])
            for _ in range(6):
                time.sleep(0.5)
                status(view["id"])
                sweep_once()
        self.assertEqual(status(view["id"])["status"], "ready")

    def test_the_hard_cap_stops_a_session_that_is_being_used(self):
        # Same clock discipline as the idle case above, for the same reason.
        with mock.patch.dict(os.environ, {"PREVIEW_MAX_SECONDS": "60"}):
            view = self.started()
            wait_for(view["id"])
            status(view["id"])  # actively touched, and it still goes
            acted = sweep_once(now=time.time() + 61)
        self.assertIn((view["id"], "expired"), acted)
        self.assertEqual(status(view["id"])["stopReason"], "expired")

    def test_the_byte_budget_stops_a_session(self):
        with mock.patch.dict(os.environ, {"PREVIEW_MAX_BYTES": "1000"}):
            view = self.started()
            wait_for(view["id"])
            answer = proxy(view["id"], "GET", "/api/big")
            self.assertEqual(answer["status"], 200)
        final = status(view["id"])
        self.assertEqual(final["status"], "stopped")
        self.assertEqual(final["stopReason"], "budget")
        self.assertGreater(final["bytesServed"], 1000)

    def test_a_session_whose_app_exits_is_reported_as_failed(self):
        exits = (
            "import os, sys, time\n"
            "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
            "class H(BaseHTTPRequestHandler):\n"
            "    def do_GET(self):\n"
            "        self.send_response(200); self.send_header('Content-Length','2')\n"
            "        self.end_headers(); self.wfile.write(b'ok')\n"
            "    def log_message(self, *a): pass\n"
            "import threading\n"
            "def die():\n"
            "    time.sleep(1.0)\n"
            "    os._exit(3)\n"
            "threading.Thread(target=die, daemon=True).start()\n"
            "HTTPServer(('127.0.0.1', int(os.environ['PORT'])), H).serve_forever()\n"
        )
        view = self.started(job(files={"app.py": exits}))
        wait_for(view["id"])
        # Sweep once the app has really exited, which is what the sweep looks for.
        proc = app_session.SESSIONS[view["id"]].proc
        deadline = time.monotonic() + 10
        while proc is not None and proc.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        sweep_once()
        final = status(view["id"])
        self.assertEqual(final["status"], "failed")
        self.assertEqual(final["message"], app_session.STOPPED_ON_ITS_OWN)

    def test_a_stopped_session_is_remembered_and_then_forgotten(self):
        view = self.started()
        wait_for(view["id"])
        stop(view["id"])
        self.assertEqual(status(view["id"])["stopReason"], "learner")
        with mock.patch.object(app_session, "REMEMBER_SECONDS", 0):
            sweep_once()
        with self.assertRaises(UnknownSession):
            status(view["id"])


class StopTest(PreviewCase):
    FORKS = (
        "import os, sys\n"
        "try:\n"
        "    pid = os.fork()\n"
        "except OSError as err:\n"
        "    print('nofork %s' % err.errno, flush=True)\n"
        "else:\n"
        "    if pid == 0:\n"
        "        import time\n"
        "        time.sleep(300)\n"
        "        os._exit(0)\n"
        "    print('child %d' % pid, flush=True)\n"
        "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
        "class H(BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        self.send_response(200); self.send_header('Content-Length','2')\n"
        "        self.end_headers(); self.wfile.write(b'ok')\n"
        "    def log_message(self, *a): pass\n"
        "HTTPServer(('127.0.0.1', int(os.environ['PORT'])), H).serve_forever()\n"
    )

    def test_stop_reaps_the_whole_process_group(self):
        """A worker the app forked must not outlive the stop that killed the app.

        Skipped where the sandbox refuses the fork outright: RLIMIT_NPROC is
        sampled from /proc, so on a machine without one (a developer's Mac) the
        child gets the bare 64-process headroom against a uid that is already
        past it and cannot fork at all. CI runs this on Linux, where it forks.
        """
        view = self.started(job(files={"app.py": self.FORKS}))
        wait_for(view["id"])
        grandchild = None
        refused = False
        deadline = time.monotonic() + 5
        while grandchild is None and not refused and time.monotonic() < deadline:
            for line in status(view["id"], cursor=0)["console"]:
                if line["text"].startswith("child "):
                    grandchild = int(line["text"].split()[1])
                elif line["text"].startswith("nofork"):
                    refused = True
            time.sleep(0.05)
        if refused:
            self.skipTest("this machine's RLIMIT_NPROC refuses a fork inside the sandbox")
        self.assertIsNotNone(grandchild, "the app never reported its forked child")
        os.kill(grandchild, 0)  # alive before the stop
        stop(view["id"])
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                os.kill(grandchild, 0)
            except OSError:
                break
            time.sleep(0.05)
        with self.assertRaises(OSError):
            os.kill(grandchild, 0)

    def test_stop_goes_through_reap_group_rather_than_a_bare_kill(self):
        """The one assertion that tells the two apart on a machine that cannot fork.

        `proc.kill()` and `reap_group(proc.pid)` look identical from outside when
        the child never forked: the group has one member either way. What
        separates them is which call is made, and on a laptop (see the skip
        above) that is the only evidence available.
        """
        view = self.started()
        wait_for(view["id"])
        pid = app_session.SESSIONS[view["id"]].proc.pid
        with mock.patch.object(app_session, "reap_group",
                               wraps=app_session.reap_group) as reaper:
            stop(view["id"])
        reaper.assert_called_once_with(pid, group_id=pid)

    def test_stop_kills_the_group_and_not_only_the_child(self):
        """The platform-independent half of the case above.

        `reap_group` signals the process group the child leads (spawn_child's
        preexec calls os.setsid). If a stop ever went back to `proc.kill()`,
        this is the assertion that would notice: the group would still exist,
        because the child would still be its only member and still be alive.
        """
        view = self.started()
        wait_for(view["id"])
        session = app_session.SESSIONS[view["id"]]
        pgid = os.getpgid(session.proc.pid)
        self.assertEqual(pgid, session.proc.pid, "the child does not lead its own group")
        stop(view["id"])
        with self.assertRaises(OSError):
            os.killpg(pgid, 0)

    def _group_answers(self, times):
        """os.killpg with signal 0 answering "still there" `times` times (None: always).

        Every other signal goes to the real call, so the stop still kills the
        group; only the "is it gone yet?" probe is played. Returns the patch and
        the monotonic times of each probe.
        """
        real = os.killpg
        probes = []

        def killpg(pgid, sig):
            if sig != 0:
                return real(pgid, sig)
            probes.append(time.monotonic())
            if times is None or len(probes) <= times:
                return None
            raise ProcessLookupError()
        return mock.patch.object(app_session.os, "killpg", side_effect=killpg), probes

    def test_a_group_that_lingers_a_moment_after_the_leader_is_still_confirmed(self):
        """A killed worker init has not yet collected must not cost the seat.

        One probe that finds the group still answering is not the answer: the
        stop keeps asking for GROUP_GONE_SECONDS, so it does not come back
        unconfirmed and leave the seat held until the five-second sweep.
        """
        view = self.started()
        wait_for(view["id"])
        patch, probes = self._group_answers(3)
        with patch:
            answer = stop(view["id"])
        self.assertTrue(answer["cleanupConfirmed"])
        self.assertEqual(len(probes), 4)

    def test_the_wait_for_the_group_is_bounded_and_then_answers_unconfirmed(self):
        """A group that never goes is never called gone; the wait has a ceiling."""
        view = self.started()
        wait_for(view["id"])
        workspace = app_session.SESSIONS[view["id"]].workspace
        patch, probes = self._group_answers(None)
        with mock.patch.object(app_session, "GROUP_GONE_SECONDS", 0.3), patch:
            answer = stop(view["id"])
        self.assertFalse(answer["cleanupConfirmed"])
        self.assertTrue(os.path.isdir(workspace), "an unconfirmed stop kept the workspace")
        self.assertGreater(len(probes), 1, "it asked once and gave up")
        self.assertGreaterEqual(probes[-1] - probes[0], 0.3 - app_session.GROUP_POLL_SECONDS)
        self.assertLess(probes[-1] - probes[0], 1.0)
        # The next ask, with the group gone, confirms it.
        self.assertTrue(stop(view["id"])["cleanupConfirmed"])
        self.assertFalse(os.path.exists(workspace))

    def test_stop_throws_the_workspace_away(self):
        view = self.started()
        wait_for(view["id"])
        workspace = app_session.SESSIONS[view["id"]].workspace
        self.assertTrue(os.path.isdir(workspace))
        stop(view["id"])
        self.assertFalse(os.path.exists(workspace))

    def test_stop_all_stops_every_live_session(self):
        first = self.started()
        second = self.started()
        wait_for(first["id"])
        wait_for(second["id"])
        self.assertEqual(stop_all(), 2)
        self.assertEqual(status(first["id"])["stopReason"], "shutdown")
        self.assertEqual(status(second["id"])["stopReason"], "shutdown")


class ServiceCommandTest(PreviewCase):
    def test_a_command_the_runner_will_not_start_is_refused_before_a_slot_is_taken(self):
        with self.assertRaises(ValueError):
            start(job(service={"command": ["node", "web/serve.js"], "portEnv": "PORT",
                               "health": "/"}))
        self.assertEqual(app_session.SESSIONS, {})

    def test_an_illegal_environment_name_is_refused(self):
        with self.assertRaises(ValueError):
            start(job(env={"lower_case": "1"}))
        self.assertEqual(app_session.SESSIONS, {})

    def test_a_pack_may_not_set_a_runner_owned_variable(self):
        with self.assertRaises(ValueError):
            start(job(env={"PATH": "/usr/bin"}))
        self.assertEqual(
            [s for s in app_session.SESSIONS.values() if s.status in ("starting", "ready")],
            [],
        )


class SeedTest(PreviewCase):
    SEEDED = (
        "import os, json\n"
        "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
        "class H(BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        body = open('data.json','rb').read() if os.path.exists('data.json') else b'[]'\n"
        "        self.send_response(200)\n"
        "        self.send_header('Content-Length', str(len(body)))\n"
        "        self.end_headers(); self.wfile.write(body)\n"
        "    def log_message(self, *a): pass\n"
        "HTTPServer(('127.0.0.1', int(os.environ['PORT'])), H).serve_forever()\n"
    )
    SEED = "open('data.json','w').write('[\"seeded\"]')\nprint('seeded ten tasks')\n"

    def test_the_seed_runs_before_the_app_and_its_output_is_in_the_console(self):
        view = self.started(job(
            files={"app.py": self.SEEDED, "seed.py": self.SEED},
            seed=["python3", "seed.py"],
        ))
        ready = wait_for(view["id"])
        self.assertEqual(ready["status"], "ready", ready)
        answer = proxy(view["id"], "GET", "/")
        self.assertEqual(json.loads(body_of(answer)), ["seeded"])
        text = " ".join(line["text"] for line in status(view["id"], cursor=0)["console"])
        self.assertIn("seeded ten tasks", text)

    def test_a_seed_that_fails_does_not_stop_the_app_from_starting(self):
        view = self.started(job(
            files={"app.py": self.SEEDED, "seed.py": "raise SystemExit(1)\n"},
            seed=["python3", "seed.py"],
        ))
        ready = wait_for(view["id"])
        self.assertEqual(ready["status"], "ready", ready)
        text = " ".join(line["text"] for line in status(view["id"], cursor=0)["console"])
        self.assertIn("may have no data in it", text)


class CanonicalAppTest(PreviewCase):
    """The pack itself, not a stand-in. Skipped where the pre-bake is absent."""

    ROOT = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))))),
        "content", "tasktrackr", "canonical",
    )

    @unittest.skipIf(sandbox_runner.runtime_site_packages() is None,
                     "the pre-baked layer is not built; run npm run prebake")
    @unittest.skipIf(not os.path.isdir(os.path.join(ROOT, "api")),
                     "the canonical application is not in this tree")
    def test_the_canonical_api_starts_and_answers_through_the_proxy(self):
        files = {}
        for dirpath, dirnames, filenames in os.walk(self.ROOT):
            dirnames[:] = [d for d in dirnames
                           if d not in ("__pycache__", "node_modules", "dist", ".pytest_cache")]
            for name in filenames:
                if name.endswith((".py", ".sql", ".html", ".json")):
                    full = os.path.join(dirpath, name)
                    rel = os.path.relpath(full, self.ROOT)
                    with open(full, encoding="utf-8") as fh:
                        files[rel] = fh.read()
        view = self.started({
            "mode": "preview",
            "files": files,
            "service": {"command": ["python3", "api/main.py"], "portEnv": "PORT",
                        "health": "/api/health"},
            "web": {"root": "web/dist", "html": "web/index.html"},
            "env": {"TASKTRACKR_DB": "data/preview.sqlite"},
            "seed": ["python3", "ops/seed.py"],
        })
        ready = wait_for(view["id"], timeout=60)
        self.assertEqual(ready["status"], "ready", ready)
        answer = proxy(view["id"], "GET", "/api/health")
        self.assertEqual(answer["status"], 200)
        self.assertEqual(json.loads(body_of(answer))["status"], "ok")
        lists = proxy(view["id"], "GET", "/api/lists")
        self.assertEqual(lists["status"], 200)
        self.assertTrue(json.loads(body_of(lists)), "the seed put nothing in the database")
        page = asset(view["id"], "/")
        self.assertIn(b'data-app="tasktrackr"', body_of(page))


class SweeperTest(unittest.TestCase):
    """The background tick keeps going when one sweep raises, and says why."""

    class Stop(Exception):
        pass

    def tick(self, sweep_error, stderr):
        """Run _sweep_forever for two sweeps on this thread, then stop it."""
        real_sleep = time.sleep
        this_thread = threading.current_thread()
        sleeps = []

        def sleep(seconds):
            # Only this thread's loop is counted: a sweeper another test started
            # shares the module and keeps its own real tick.
            if threading.current_thread() is not this_thread:
                return real_sleep(seconds)
            sleeps.append(seconds)
            if len(sleeps) > 2:
                raise self.Stop()
            return None

        with mock.patch.object(app_session.time, "sleep", side_effect=sleep), \
                mock.patch.object(app_session, "sweep_once", side_effect=sweep_error), \
                mock.patch.object(sys, "stderr", stderr):
            with self.assertRaises(self.Stop):
                app_session._sweep_forever(app_session.SWEEP_INTERVAL_SECONDS)
        return sleeps

    def test_a_sweep_that_raises_is_logged_and_the_next_tick_still_comes(self):
        log = io.StringIO()
        sleeps = self.tick(RuntimeError("the register is broken"), log)
        self.assertEqual(sleeps, [app_session.SWEEP_INTERVAL_SECONDS] * 3)
        self.assertIn("preview sweep failed: RuntimeError: the register is broken", log.getvalue())

    def test_a_log_nobody_reads_does_not_stop_the_tick(self):
        class DeadPipe:
            def write(self, _text):
                raise BrokenPipeError()

            def flush(self):
                raise BrokenPipeError()

        sleeps = self.tick(RuntimeError("the register is broken"), DeadPipe())
        self.assertEqual(len(sleeps), 3)


class BuiltInPageTest(unittest.TestCase):
    """The page served in place of a bundle that failed belongs to the runner."""

    def test_its_title_is_neutral_whichever_pack_is_running(self):
        self.assertIn("<title>Preview</title>", app_session.BUILT_IN_PAGE)
        self.assertIn(BUNDLE_FAILED, app_session.BUILT_IN_PAGE)


class LambdaTransportTest(unittest.TestCase):
    """A preview cannot run on Lambda, and saying so is not an outage."""

    def test_a_preview_job_comes_back_as_an_envelope_rather_than_an_exception(self):
        import lambda_handler

        answer = lambda_handler.handler({"mode": "preview", "files": {}}, None)
        self.assertEqual(answer, {"error": lambda_handler.PREVIEW_UNAVAILABLE})

    def test_a_test_job_is_still_executed(self):
        import lambda_handler

        answer = lambda_handler.handler({
            "mode": "tests",
            "language": "python",
            "files": {"test_ok.py": "import unittest\n\n"
                                    "class T(unittest.TestCase):\n"
                                    "    def test_ok(self):\n"
                                    "        self.assertTrue(True)\n"},
            "testPaths": ["test_ok.py"],
        }, None)
        self.assertTrue(answer["ok"], answer)


if __name__ == "__main__":
    unittest.main()
