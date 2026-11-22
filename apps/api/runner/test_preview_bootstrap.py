"""What the live preview's sandbox refuses, and the little it permits.

The graded bootstrap blocks every socket outright. A learner's own app has to
listen on one, so `PREVIEW_BOOTSTRAP` relaxes exactly one thing: loopback. This
file is written the way a security change is reviewed (every refusal first,
and only then the four permissions), because the failure mode here is not a
wrong answer on a screen, it is a learner's process with a route out.

The probes run the way the preview's child runs: `python3 -S -B -c
PREVIEW_BOOTSTRAP probe.py`, spawned through the same `run_child` with the same
environment allowlist. Nothing here mocks the policy; each probe is a real
process making a real call.
"""

import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sandbox_runner  # noqa: E402
from sandbox_runner import (  # noqa: E402
    PREVIEW_BOOTSTRAP,
    execute_job,
    preview_argv,
    run_child,
)

PROBE = "probe.py"

# Each probe prints one JSON line: {"ok": bool, "error": "TypeName: message"}.
# A refusal is an error class and a sentence, and both matter: "PermissionError"
# with the sandbox's own wording is what tells a learner their app tried to
# reach the network, where a bare OSError would read as a bug in their code.
PREAMBLE = '''
import json, os, socket, sys


def report(fn):
    try:
        value = fn()
    except BaseException as err:
        print(json.dumps({"ok": False, "error": f"{type(err).__name__}: {err}"}))
    else:
        print(json.dumps({"ok": True, "value": repr(value)}))
'''


def probe(body, extra_env=None, files=None, timeout=15):
    """Run one probe under PREVIEW_BOOTSTRAP and return its JSON line."""
    workspace = tempfile.mkdtemp(prefix="lsdlc-probe-")
    try:
        for rel, content in (files or {}).items():
            path = os.path.join(workspace, rel)
            os.makedirs(os.path.dirname(path) or workspace, exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(content)
        with open(os.path.join(workspace, PROBE), "w", encoding="utf-8") as fh:
            fh.write(PREAMBLE + body)
        code, stdout, stderr, kind = run_child(
            preview_argv(["python3", PROBE]),
            workspace,
            timeout,
            256,
            extra_env=extra_env,
            nofile=256,
        )
        lines = [l for l in stdout.splitlines() if l.startswith("{")]
        if not lines:
            raise AssertionError(
                f"probe printed no JSON line (exit {code}, {kind})\n{stdout}\n{stderr}"
            )
        return json.loads(lines[-1])
    finally:
        import shutil

        shutil.rmtree(workspace, ignore_errors=True)


class Listener:
    """A loopback server in the parent, for the probes that are allowed to reach one."""

    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.port = self.sock.getsockname()[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            conn.sendall(b"ok")
            conn.close()

    def close(self):
        self.sock.close()


# --------------------------------------------------------------------------
# What it refuses. Every one of these is red without the policy: with a plain
# interpreter the call simply succeeds.
# --------------------------------------------------------------------------


class RefusesTheNetworkTest(unittest.TestCase):
    def test_connecting_to_a_public_host_raises(self):
        answer = probe(
            'report(lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM)'
            '.connect(("example.com", 80)))'
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])

    def test_connecting_to_a_private_address_that_is_not_loopback_raises(self):
        # The classroom LAN, the metadata service, the database on the other
        # side of the compose network: all of them are this case.
        answer = probe(
            'report(lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM)'
            '.connect(("10.0.0.1", 80)))'
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])

    def test_connect_ex_is_refused_too(self):
        # connect_ex returns an errno rather than raising, so an app that used
        # it would silently probe the network if only connect were wrapped.
        answer = probe(
            'report(lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM)'
            '.connect_ex(("10.0.0.1", 80)))'
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])

    def test_resolving_a_hostname_raises(self):
        answer = probe('report(lambda: socket.getaddrinfo("example.com", 80))')
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])

    def test_gethostbyname_raises(self):
        answer = probe('report(lambda: socket.gethostbyname("example.com"))')
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])

    def test_a_datagram_socket_cannot_reach_off_the_machine(self):
        # UDP never connects, so `connect` on a datagram socket is the one call
        # that would look harmless and still send.
        answer = probe(
            'report(lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM)'
            '.connect(("8.8.8.8", 53)))'
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])


class RefusesAWildcardBindTest(unittest.TestCase):
    """Binding 0.0.0.0 is the mistake that puts a learner's app on the LAN."""

    def test_binding_all_interfaces_raises(self):
        answer = probe(
            'report(lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM)'
            '.bind(("0.0.0.0", 0)))'
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])

    def test_binding_the_empty_host_raises(self):
        # "" is what HTTPServer(("", port)) passes, and it means every interface.
        answer = probe(
            'report(lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM)'
            '.bind(("", 0)))'
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])

    def test_binding_every_ipv6_interface_raises(self):
        answer = probe(
            'report(lambda: socket.socket(socket.AF_INET6, socket.SOCK_STREAM)'
            '.bind(("::", 0)))'
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])

    def test_binding_a_routable_address_raises(self):
        answer = probe(
            'report(lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM)'
            '.bind(("10.0.0.1", 0)))'
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])


class StillRefusesEverythingTheGradedSandboxDoesTest(unittest.TestCase):
    """The relaxation is loopback and nothing else."""

    def test_exec_is_still_refused(self):
        answer = probe('report(lambda: os.execv("/bin/sh", ["sh", "-c", "true"]))')
        self.assertFalse(answer["ok"], answer)
        self.assertIn("spawning processes is disabled", answer["error"])

    def test_system_is_still_refused(self):
        answer = probe('report(lambda: os.system("true"))')
        self.assertFalse(answer["ok"], answer)
        self.assertIn("spawning processes is disabled", answer["error"])

    def test_subprocess_cannot_start_anything(self):
        answer = probe(
            'import subprocess\n'
            'report(lambda: subprocess.run(["/bin/echo", "hi"]))'
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("spawning processes is disabled", answer["error"])

    def test_ctypes_is_still_refused(self):
        # ctypes reaches libc's socket() and execve() straight past every patch
        # above, so the import block is what makes the rest of this file true.
        answer = probe('report(lambda: __import__("ctypes"))')
        self.assertFalse(answer["ok"], answer)
        self.assertIn("not available in the LearnSDLC sandbox", answer["error"])

    def test_socketpair_is_still_refused(self):
        # Not wrapped but blocked outright, and it keeps the graded sentence: a
        # socket pair has no address to check, so there is nothing to allow.
        answer = probe('report(lambda: socket.socketpair())')
        self.assertFalse(answer["ok"], answer)
        self.assertIn("network access is disabled", answer["error"])

    def test_a_unix_socket_outside_the_workspace_is_refused(self):
        # The runner's own control socket is a UNIX socket on a shared volume.
        answer = probe(
            'report(lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)'
            '.connect("/run/learnsdlc/runner.sock"))'
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])

    def test_a_unix_socket_in_a_sibling_that_shares_the_workspace_prefix_is_refused(self):
        # "<workspace>x" starts with the workspace's own path but is a different
        # directory beside it. Containment means the workspace itself or a path
        # under it followed by a separator, the same rule as the file checks.
        answer = probe(
            'def go():\n'
            '    root = os.path.realpath(os.getcwd())\n'
            '    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n'
            '    s.bind(root + "x" + os.sep + "app.sock")\n'
            'report(go)'
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])
        self.assertIn("only allows loopback", answer["error"])

    def test_the_graded_sandbox_still_blocks_every_socket(self):
        # The other half of the same contract: relaxing the preview must not
        # have relaxed a graded run. socketpair is the call a test would use to
        # prove it had one.
        result = execute_job({
            "mode": "tests",
            "language": "python",
            "files": {
                "test_net.py": (
                    "import socket, unittest\n\n"
                    "class TestNet(unittest.TestCase):\n"
                    "    def test_socketpair(self):\n"
                    "        socket.socketpair()\n"
                ),
            },
            "testPaths": ["test_net.py"],
        })
        self.assertEqual(result["tests"]["errored"], 1, result)
        self.assertIn("network access is disabled", json.dumps(result["tests"]["cases"]))


# --------------------------------------------------------------------------
# What it permits: loopback, and the app that needs it.
# --------------------------------------------------------------------------


class PermitsLoopbackTest(unittest.TestCase):
    def test_connecting_to_loopback_works(self):
        listener = Listener()
        try:
            answer = probe(
                'port = int(os.environ["PROBE_PORT"])\n'
                'def go():\n'
                '    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n'
                '    s.connect(("127.0.0.1", port))\n'
                '    return s.recv(2).decode()\n'
                'report(go)',
                extra_env={"PROBE_PORT": str(listener.port)},
            )
        finally:
            listener.close()
        self.assertTrue(answer["ok"], answer)
        self.assertIn("ok", answer["value"])

    def test_binding_loopback_works(self):
        answer = probe(
            'def go():\n'
            '    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n'
            '    s.bind(("127.0.0.1", 0))\n'
            '    s.listen(1)\n'
            '    return s.getsockname()[0]\n'
            'report(go)'
        )
        self.assertTrue(answer["ok"], answer)
        self.assertIn("127.0.0.1", answer["value"])

    def test_localhost_resolves_and_nothing_else_does(self):
        answer = probe(
            'report(lambda: [a[4][0] for a in '
            'socket.getaddrinfo("localhost", 80, socket.AF_INET)])'
        )
        self.assertTrue(answer["ok"], answer)
        self.assertIn("127.0.0.1", answer["value"])

    def test_a_unix_socket_inside_the_workspace_works(self):
        # The learner's app may keep its own socket beside its own files; that
        # is inside the temp workspace and dies with it.
        answer = probe(
            'def go():\n'
            '    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n'
            '    s.bind(os.path.join(os.getcwd(), "app.sock"))\n'
            '    return "bound"\n'
            'report(go)'
        )
        self.assertTrue(answer["ok"], answer)

    def test_a_unix_socket_in_a_folder_inside_the_workspace_works(self):
        answer = probe(
            'def go():\n'
            '    os.mkdir("run")\n'
            '    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n'
            '    s.bind(os.path.join(os.getcwd(), "run", "app.sock"))\n'
            '    return "bound"\n'
            'report(go)'
        )
        self.assertTrue(answer["ok"], answer)


@unittest.skipIf(
    sandbox_runner.runtime_site_packages() is None,
    "the pre-baked layer is not built on this machine; run npm run prebake",
)
class FlaskServesOverLoopbackTest(unittest.TestCase):
    """The whole point: the pack's own server starts under this policy.

    Werkzeug's development server is what `python3 api/main.py` runs, and it
    reaches for parts of `socket` that a narrower allowlist would have refused.
    Proving it here rather than in the supervisor keeps the failure legible: if
    this breaks, the policy is wrong, not the supervisor.
    """

    def test_a_flask_app_answers_a_request_on_loopback(self):
        app = (
            "import os\n"
            "from flask import Flask\n"
            "import threading, urllib.request, json\n"
            "app = Flask(__name__)\n"
            "@app.get('/api/health')\n"
            "def health():\n"
            "    return {'status': 'ok'}\n"
            "def call(port):\n"
            "    import time\n"
            "    for _ in range(60):\n"
            "        try:\n"
            "            body = urllib.request.urlopen(\n"
            "                f'http://127.0.0.1:{port}/api/health', timeout=2).read()\n"
            "        except Exception:\n"
            "            time.sleep(0.25)\n"
            "            continue\n"
            "        print(json.dumps({'ok': True, 'value': body.decode()}))\n"
            "        os._exit(0)\n"
            "    print(json.dumps({'ok': False, 'error': 'no answer'}))\n"
            "    os._exit(1)\n"
            "port = int(os.environ['PORT'])\n"
            "threading.Thread(target=call, args=(port,), daemon=True).start()\n"
            "app.run(host='127.0.0.1', port=port)\n"
        )
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        answer = probe(app, extra_env={"PORT": str(port)}, timeout=45)
        self.assertTrue(answer["ok"], answer)
        self.assertIn("ok", answer["value"])


class PreviewArgvTest(unittest.TestCase):
    def test_the_command_runs_under_the_bootstrap(self):
        argv = preview_argv(["python3", "api/main.py"])
        self.assertEqual(argv[0], sys.executable)
        self.assertIn("-S", argv)
        self.assertIn("-B", argv)
        self.assertEqual(argv[-2], PREVIEW_BOOTSTRAP)
        self.assertEqual(argv[-1], "api/main.py")

    def test_a_node_service_is_refused_rather_than_run_unsandboxed(self):
        # The bootstrap is a Python program. A node service would start with no
        # policy at all, which is worse than not starting: it could spawn.
        with self.assertRaises(ValueError) as raised:
            preview_argv(["node", "web/serve.js"])
        self.assertIn("python3", str(raised.exception))

    def test_an_empty_command_is_refused(self):
        with self.assertRaises(ValueError):
            preview_argv([])


class PreviewDeadlineTest(unittest.TestCase):
    """The child stops itself, whether or not anybody is still watching it.

    The idle sweep, the ten-minute hard cap and the byte budget all live in
    `app_session.sweep_once`, in the runner process. Kill the runner rather than
    shut it down and none of them is enforced: the child is reparented to init,
    blocks in accept() spending no CPU so RLIMIT_CPU never fires, and outlives
    everything. These two cases are the child's own half of the bound.
    """

    def _run(self, body, seconds, timeout=20):
        workspace = tempfile.mkdtemp(prefix="lsdlc-deadline-")
        try:
            with open(os.path.join(workspace, PROBE), "w", encoding="utf-8") as fh:
                fh.write(body)
            env = {} if seconds is None else {"LSDLC_PREVIEW_SECONDS": str(seconds)}
            started = time.monotonic()
            code, stdout, stderr, kind = run_child(
                preview_argv(["python3", PROBE]),
                workspace,
                timeout,
                256,
                extra_env=env,
                nofile=256,
            )
            return code, stdout, stderr, kind, time.monotonic() - started
        finally:
            import shutil

            shutil.rmtree(workspace, ignore_errors=True)

    def test_a_child_nobody_is_watching_stops_at_its_deadline(self):
        # An app that sleeps is an app spending no CPU: nothing else in the
        # sandbox would ever end this process.
        code, _stdout, stderr, kind, took = self._run(
            "import time\ntime.sleep(600)\n", seconds=1
        )
        self.assertEqual(kind, "ok", f"the child had to be killed: {stderr}")
        self.assertEqual(code, 75)
        self.assertLess(took, 15, "the deadline did not fire")
        self.assertIn("stopped itself", stderr)

    def test_without_a_deadline_nothing_is_armed(self):
        # The variable is the only switch: a child started without one runs
        # exactly as it did before, which is what keeps every other probe in
        # this file measuring the policy rather than the timer.
        code, stdout, _stderr, kind, _took = self._run(
            "print('ran to the end')\n", seconds=None
        )
        self.assertEqual((code, kind), (0, "ok"))
        self.assertIn("ran to the end", stdout)

    def test_the_supervisor_passes_a_deadline_longer_than_its_own_cap(self):
        # Longer on purpose: a supervised session must be stopped by the sweep,
        # which reports `expired`, and not by the child, which would report as a
        # crash. The child's deadline is the backstop, not the bound.
        self.assertGreater(sandbox_runner.PREVIEW_DEADLINE_GRACE_SECONDS, 5)
        self.assertEqual(sandbox_runner.PREVIEW_DEADLINE_ENV, "LSDLC_PREVIEW_SECONDS")


# --------------------------------------------------------------------------
# The files. Every child the runner starts is the same uid in the same
# container with one /tmp, and a preview lives for ten minutes: without the
# file policy a learner's app could list /tmp and read every other learner's
# in-flight run. Each case below plants a sibling workspace the way execute_job
# does (mkdtemp under the same temp directory) and asks the child to reach it.
# --------------------------------------------------------------------------

SECRET = "SECRET_HIDDEN_TEST"


class SiblingWorkspace:
    """Another learner's run: a sibling mkdtemp holding a hidden test file."""

    def __init__(self):
        self.path = tempfile.mkdtemp(prefix="lsdlc-")
        self.file = os.path.join(self.path, "test_hidden.py")
        with open(self.file, "w", encoding="utf-8") as fh:
            fh.write(SECRET + "\n")

    def close(self):
        import shutil

        shutil.rmtree(self.path, ignore_errors=True)


def fs_probe(body, sibling):
    """Run one probe with the sibling's path in V. Returns its JSON line."""
    return probe(
        "import glob, io, pathlib, sqlite3, tempfile\n"
        f"V = {sibling.path!r}\n"
        f"F = {sibling.file!r}\n"
        + body
    )


class RefusesASiblingWorkspaceTest(unittest.TestCase):
    def setUp(self):
        self.sibling = SiblingWorkspace()
        self.addCleanup(self.sibling.close)

    def assertRefused(self, answer):
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])
        self.assertIn("inside its own workspace", answer["error"])
        self.assertNotIn(SECRET, json.dumps(answer))

    def test_the_temp_directory_cannot_be_enumerated(self):
        # The verifier's own repro: glob + walk + open across /tmp/lsdlc-*.
        # glob and walk swallow the refusal and answer nothing, which is the
        # point: there is no name to open next.
        answer = fs_probe(
            "report(lambda: (glob.glob(os.path.join(os.path.dirname(V), 'lsdlc-*')),"
            " list(os.walk(os.path.dirname(V)))))",
            self.sibling,
        )
        self.assertTrue(answer["ok"], answer)
        self.assertEqual(answer["value"], "([], [])")

    def test_listing_a_sibling_raises(self):
        self.assertRefused(fs_probe("report(lambda: os.listdir(V))", self.sibling))
        self.assertRefused(fs_probe("report(lambda: list(os.scandir(V)))", self.sibling))
        self.assertRefused(fs_probe("report(lambda: list(pathlib.Path(V).iterdir()))", self.sibling))

    def test_every_way_of_opening_a_sibling_file_raises(self):
        for call in (
            "open(F).read()",
            "io.open(F).read()",
            "io.FileIO(F).read()",
            "io.open_code(F).read()",
            "os.open(F, os.O_RDONLY)",
            "pathlib.Path(F).read_text()",
            "sqlite3.connect(os.path.join(V, 'x.db'))",
            "sqlite3.connect('file://localhost' + os.path.join(V, 'x.db'), uri=True)",
        ):
            with self.subTest(call=call):
                self.assertRefused(fs_probe(f"report(lambda: {call})", self.sibling))

    def test_importing_from_a_sibling_finds_nothing(self):
        # The import machinery reads through the same patched calls: the
        # finder's listdir is refused and answers an empty directory.
        answer = fs_probe(
            "report(lambda: (sys.path.append(V), __import__('test_hidden')))", self.sibling
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("ModuleNotFoundError", answer["error"])

    def test_a_sibling_cannot_be_written_or_moved_either(self):
        # Reading is the leak; writing would let one learner tamper with
        # another's run mid-flight.
        self.assertRefused(fs_probe("report(lambda: open(os.path.join(V, 'tamper.py'), 'w'))", self.sibling))
        self.assertRefused(fs_probe("report(lambda: os.rename(F, F + '.moved'))", self.sibling))
        self.assertRefused(fs_probe("report(lambda: os.remove(F))", self.sibling))
        self.assertRefused(fs_probe("report(lambda: os.mkdir(os.path.join(V, 'd')))", self.sibling))
        self.assertTrue(os.path.exists(self.sibling.file))

    def test_a_symlink_is_judged_by_where_it_points(self):
        self.assertRefused(fs_probe(
            "report(lambda: (os.symlink(V, 'link'), open('link/test_hidden.py').read()))",
            self.sibling,
        ))

    def test_leaving_the_workspace_with_chdir_raises(self):
        self.assertRefused(fs_probe("report(lambda: os.chdir(V))", self.sibling))

    def test_the_dir_fd_forms_are_refused(self):
        answer = fs_probe(
            "report(lambda: os.open('test_hidden.py', os.O_RDONLY, dir_fd=os.open('.', os.O_RDONLY)))",
            self.sibling,
        )
        self.assertFalse(answer["ok"], answer)
        self.assertIn("PermissionError", answer["error"])

    def test_the_patched_modules_cannot_be_imported_fresh(self):
        for name in ("_io", "_sqlite3"):
            with self.subTest(module=name):
                answer = fs_probe(
                    f"report(lambda: (sys.modules.pop({name!r}), __import__({name!r})))",
                    self.sibling,
                )
                self.assertFalse(answer["ok"], answer)
                self.assertIn("ImportError", answer["error"])

    def test_linecache_reads_through_the_policy(self):
        # tokenize bound the real open before the policy ran; linecache reads
        # source through it, and a refused read is an empty file.
        answer = fs_probe("import linecache\nreport(lambda: linecache.getlines(F))", self.sibling)
        self.assertTrue(answer["ok"], answer)
        self.assertEqual(answer["value"], "[]")

    def test_the_graded_bootstrap_refuses_a_sibling_too(self):
        # Same tail, same rule: a hidden suite's neighbour is as unreadable
        # from a test run as from a preview.
        result = execute_job({
            "files": {
                "tests/test_reach.py": (
                    "import os, unittest\n\n\n"
                    "class TestReach(unittest.TestCase):\n"
                    "    def test_reach(self):\n"
                    f"        with self.assertRaises(PermissionError):\n"
                    f"            os.listdir({self.sibling.path!r})\n"
                    f"        with self.assertRaises(PermissionError):\n"
                    f"            open({self.sibling.file!r})\n"
                )
            },
            "mode": "tests",
            "testPaths": ["tests/test_reach.py"],
            "language": "python",
            "timeoutSeconds": 20,
            "memoryMb": 256,
        })
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["tests"]["passed"], 1)


class TheWorkspaceStillWorksTest(unittest.TestCase):
    """What a learner's app does need, all still allowed."""

    def test_its_own_files_and_temp_files(self):
        answer = probe(
            "import tempfile, shutil, sqlite3\n"
            "def go():\n"
            "    open('mine.txt', 'w').write('hi')\n"
            "    fd, path = tempfile.mkstemp()\n"
            "    os.close(fd)\n"
            "    os.makedirs('d/e')\n"
            "    shutil.rmtree('d')\n"
            "    rows = sqlite3.connect('own.db').execute('select 1').fetchall()\n"
            "    open('/dev/null', 'w').write('x')\n"
            "    return (open('mine.txt').read(), os.path.realpath(os.path.dirname(path)) == os.path.realpath(os.environ['TMPDIR']),\n"
            "            os.path.exists('d'), rows, sorted(os.listdir('.')))\n"
            "report(go)"
        )
        self.assertTrue(answer["ok"], answer)
        self.assertEqual(
            answer["value"],
            repr(("hi", True, False, [(1,)], [".lsdlc-tmp", "mine.txt", "own.db", "probe.py"])),
        )

    def test_the_temp_directory_is_inside_the_workspace(self):
        # /tmp is on the far side of the fence, so the child's tempfile has
        # to land somewhere it can reach, and somewhere thrown away with the
        # run.
        answer = probe(
            "import tempfile\n"
            "report(lambda: os.path.realpath(tempfile.gettempdir()).startswith(os.getcwd()))"
        )
        self.assertEqual(answer, {"ok": True, "value": "True"})

    def test_the_standard_library_and_system_files_are_readable(self):
        answer = probe(
            "import mimetypes, json, zoneinfo\n"
            "report(lambda: (mimetypes.guess_type('a.json')[0], "
            "open('/etc/hosts').read(1) != '', "
            "os.listdir(os.path.dirname(json.__file__)) != []))"
        )
        self.assertEqual(answer, {"ok": True, "value": repr(("application/json", True, True))})

    @unittest.skipIf(sandbox_runner.runtime_site_packages() is None, "nothing is pre-baked")
    def test_the_pre_baked_library_is_readable(self):
        answer = probe("report(lambda: (__import__('flask').__name__, os.listdir(os.environ['LSDLC_PYLIB']) != []))")
        self.assertEqual(answer, {"ok": True, "value": repr(("flask", True))})


if __name__ == "__main__":
    unittest.main()
