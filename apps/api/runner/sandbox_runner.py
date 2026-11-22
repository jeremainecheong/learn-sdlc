"""LearnSDLC sandbox runner.

Executes untrusted learner code in a constrained child process. Reads a JSON
job from stdin and writes a JSON result to stdout:

  {
    "files":          {"relative/path.py": "content", ...},
    "gradedFiles":    {"tasktrackr/manager.py": "content", ...}, # mode=tests, optional
    "mode":           "tests" | "smoke",                    # default "tests"
    "language":       "python" | "javascript" | "typescript", # default "python"
    "harness":        "unittest" | "pytest" | "js",        # optional, see DEFAULT_HARNESS
    "testPaths":      ["tests/test_visible.py", ...],      # mode=tests
    "smokeCommands":  [["python3", "cli.py", "add", "x"]], # mode=smoke
    "expectInOutput": "substring",                          # mode=smoke, optional
    "clock":          "2026-03-01",                         # optional, ISO date
    "transform":      {"tool": "esbuild"},                  # optional, implied for typescript
    "fetchStubs":     {...},                                # optional, the JS harness's DOM fetch
    "runId":          "api",                                # optional, stamped on each case as "step"
    "timeoutSeconds": 10,                                   # default 10, capped at 60
    "memoryMb":       256                                   # default 256, capped at 512
  }

mode=preview is refused here: a live preview is served by app_session.py.

The result:

  {
    "ok":         true | false,
    "exitKind":   "ok" | "timeout" | "memory" | "error" | "unavailable",
    "stdout":     "...",                 # clipped, host paths redacted
    "stderr":     "...",
    "durationMs": 1234,
    "tests":      {"total", "passed", "failed", "errored", "cases": [...]} | null,
                                         # mode=tests only
    "diagnostics": {...},                # runtime_diagnostics.Diagnostics.result()
    "isolation":  {"status", "mechanism", ...}  # isolation_status()
  }

A host that cannot isolate answers "unavailable" with no "tests" key and
runs nothing.

`files` land in the workspace, which is the child's working directory and is
readable by everything it runs. `gradedFiles` are the artefacts that decide the
score (the reference implementation, the planted mutants, a hidden suite), and
they never go there: they are written outside the workspace, the harness imports
them and deletes them before a single line of learner code loads, and what is
left is an imported module with no file behind it. A learner test that opens
"tasktrackr/manager.py" gets FileNotFoundError; one that imports it gets the
module it is meant to exercise.

Constraints applied to the child: the Landlock file fence (see "the fence"
below), CPU, address-space and process-count rlimits, file-size and fd limits,
a scrubbed environment, python -I isolation, and best-effort in-process blocks
on sockets, exec and ctypes.

Everything in this file is a SECOND line of defence. In-process blocks can be
unwound by code running in the same interpreter, and rlimits do not stop a
same-uid sibling from reading /proc/<pid>/environ. The real boundary is where
this file runs: in production it runs inside the runner container
(infra/runner.Dockerfile: no network, no secrets, uid 65534, its own pid
namespace, read-only rootfs) or an isolated AWS Lambda. RUNNER_MODE=local,
which executes jobs as a child of the API process, is refused in production.
"""

import ctypes
import json
import os
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from runtime_diagnostics import CURRENT, Diagnostics, ChildSampler, stage

# Tasks (processes + threads) one job may add on top of what its uid already
# runs. RLIMIT_NPROC is a per-uid, system-wide count, so an absolute cap would
# either be meaningless (root ignores it) or break Node's startup threads on a
# busy developer account; a headroom keeps the bound meaningful everywhere.
NPROC_HEADROOM = int(os.environ.get("SANDBOX_NPROC", "64"))

PR_SET_DUMPABLE = 4

# The single line each harness prints to hand its structured result back.
RESULT_MARKER = "@@LSDLC_RESULT@@"

# The sentence a job comes back with when the pre-baked layer is not here,
# because "ModuleNotFoundError: No module named 'flask'" tells a learner their
# code is broken when it is the machine that is not set up. One wording, held
# in four places that must change together: this constant (which the preview
# build's log line in app_session._bundle imports), PREBAKE_MISSING_MESSAGE in
# apps/api/src/execution/sandbox.service.ts (which finds it in a run's stderr
# by exact text), MISSING in scripts/prebake.mjs, and the NO_PREBAKE pattern
# in apps/api/src/cli/content-check-engine.ts (which matches the words
# "sandbox dependencies are not built").
PREBAKE_MISSING_MESSAGE = (
    "The sandbox dependencies are not built on this machine. Run npm run prebake."
)


def runtime_root():
    """Where the pre-baked dependency layer lives.

    The same rule as runtime_manifest.runtime_root(), written out again rather
    than imported: the Lambda package carries only lambda_handler.py, this
    file and runtime_diagnostics.py beside the baked layer
    (scripts/localstack-lambda.sh lists them), and a runner that cannot start
    because a path helper was left out of a zip is a worse failure than a line
    of duplication. test_runtime_manifest.py asserts the two agree.
    """
    override = os.environ.get("RUNNER_RUNTIME_DIR")
    if override:
        return os.path.abspath(override)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime")


def runtime_site_packages():
    """The baked Python library directory, or None when nothing is baked."""
    directory = os.path.join(runtime_root(), "python")
    return directory if os.path.isdir(directory) else None


def runtime_node_modules():
    """The baked node_modules, or None when nothing is baked."""
    directory = os.path.join(runtime_root(), "node", "node_modules")
    return directory if os.path.isdir(directory) else None


def runtime_esbuild():
    """The baked esbuild binary, or None when nothing is baked."""
    binary = os.path.join(runtime_root(), "bin", "esbuild")
    return binary if os.path.isfile(binary) else None


def _node_bin():
    """The node a JavaScript child runs under: NODE_BIN, or `node` on PATH."""
    return os.environ.get("NODE_BIN", "node")


def protect_own_memory():
    """Make this process non-dumpable (best effort).

    A non-dumpable process's /proc/<pid>/environ and /proc/<pid>/mem are
    unreadable to other processes of the same uid. In RUNNER_MODE=local the
    runner is a child of the API and inherits its environment (JWT_SECRET,
    DATABASE_URL), so without this the learner child could lift them from
    its parent. Root still reads everything; the container runs as 65534.
    """
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
    except (OSError, AttributeError):
        pass


def uid_task_count():
    """Number of tasks (threads included) currently owned by our uid.

    Read from /proc, which inside the runner container only shows the
    container's own pid namespace. An undercount just makes the NPROC bound
    tighter than intended, never looser.
    """
    uid = str(os.getuid())
    total = 0
    try:
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open(f"/proc/{entry}/status", encoding="ascii", errors="replace") as fh:
                    threads = 1
                    mine = False
                    for line in fh:
                        if line.startswith("Uid:"):
                            mine = line.split()[1] == uid
                        elif line.startswith("Threads:"):
                            threads = int(line.split()[1])
                    if mine:
                        total += threads
            except OSError:
                continue
    except OSError:
        return 0
    return total


# ------------------------------------------------------------------ the fence
#
# Every child this runner starts (a graded test run, a smoke check, a live
# preview) is the same uid in the same container, and the container has one
# /tmp. rlimits bound what a child can spend and the bootstraps bound what its
# Python can call; nothing else bounds what it can OPEN, and a workspace's
# 0700 is no boundary against the same uid. So a preview that ran for ten
# minutes could list /tmp and read every other learner's in-flight run: their
# source, and the hidden suite the grader writes into the workspace. Two layers
# close that, and both say the same thing so that where only one holds, what
# it holds is the whole rule:
#
#   1. Landlock, where the kernel has it (Linux 5.13+). It is unprivileged, so
#      it works with every capability dropped and a read-only rootfs, which is
#      how the runner container runs. The parent builds a ruleset naming what
#      one child may reach (its own workspace and its graded directory
#      read-write; the interpreter, the baked runtime and the system
#      directories read-only; four device files), and the child applies it to
#      itself in the preexec, before exec. /tmp is deliberately not a rule: a
#      sibling's workspace is a path the kernel refuses to open, whatever the
#      program running there does and whatever it unwinds.
#   2. The file policy in _BLOCKS_TAIL, the same rule written in Python. It is
#      defence in depth inside every Python child: under the Landlock fence,
#      and inside the single-job microVM, where the fresh VM is the boundary.
#
# The kernel layer is armed only after `landlock_abi` has proved, once per
# process, that the interpreters still start under it: a directory this file
# forgot would otherwise take a whole class down at once. Outside the microVM
# there is no run without it. Where Landlock is absent (macOS, an older kernel,
# a seccomp profile that hides the syscalls), where the self-test fails, or
# where SANDBOX_LANDLOCK=0 switches the kernel layer off, `isolation_status`
# reports "unsupported" and every learner run and preview is refused. The log
# line at runner start says which of these holds.

LANDLOCK_CREATE_RULESET = 444
LANDLOCK_ADD_RULE = 445
LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38

LANDLOCK_ACCESS_FS_EXECUTE = 1 << 0
LANDLOCK_ACCESS_FS_WRITE_FILE = 1 << 1
LANDLOCK_ACCESS_FS_READ_FILE = 1 << 2
LANDLOCK_ACCESS_FS_READ_DIR = 1 << 3
LANDLOCK_ACCESS_FS_REFER = 1 << 13
LANDLOCK_ACCESS_FS_TRUNCATE = 1 << 14
LANDLOCK_ACCESS_FS_IOCTL_DEV = 1 << 15

# What a read-only root grants: enough to import, load and execute from it.
FENCE_READ = (
    LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR
)

#: The directories every child may read. The interpreter's own prefix, the
#: baked runtime and the program it runs are added per child; nothing under
#: /tmp, /home, /run, /var or /proc is ever here.
FENCE_SYSTEM_ROOTS = ("/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc")

#: The device files a child may open. /dev itself is not a rule: /dev/shm is
#: another shared tmpfs, and nothing a learner's program needs lives in /dev
#: beyond these four.
FENCE_DEVICE_FILES = ("/dev/null", "/dev/zero", "/dev/urandom", "/dev/random")

#: Where a child's tempfile module writes, relative to its workspace. /tmp is
#: outside the fence, so a run that had no private temp directory would fail
#: on its first mkstemp (pytest's capture, for one).
CHILD_TMPDIR_NAME = ".lsdlc-tmp"


class _RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class _PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


_LIBC = None


def _libc():
    global _LIBC
    if _LIBC is None:
        _LIBC = ctypes.CDLL(None, use_errno=True)
        _LIBC.syscall.restype = ctypes.c_long
    return _LIBC


def _syscall(number, *args):
    result = _libc().syscall(ctypes.c_long(number), *args)
    if result < 0:
        errno = ctypes.get_errno()
        raise OSError(errno, f"syscall {number}: {os.strerror(errno)}")
    return result


def landlock_rights(abi):
    """Every filesystem right this ABI version knows. Handling all of them is
    what makes the ruleset a denylist of everything but the rules."""
    rights = (1 << 13) - 1  # ABI 1: execute .. make_sym
    if abi >= 2:
        rights |= LANDLOCK_ACCESS_FS_REFER
    if abi >= 3:
        rights |= LANDLOCK_ACCESS_FS_TRUNCATE
    if abi >= 5:
        rights |= LANDLOCK_ACCESS_FS_IOCTL_DEV
    return rights


_LANDLOCK = {"abi": None, "note": None}


def _probe_landlock_abi():
    if sys.platform != "linux":
        return 0, "confinement: in-process file policy only (Landlock is Linux-only)"
    if os.environ.get("SANDBOX_LANDLOCK", "").strip() == "0":
        return 0, "confinement: in-process file policy only (SANDBOX_LANDLOCK=0)"
    try:
        abi = _syscall(
            LANDLOCK_CREATE_RULESET,
            ctypes.c_void_p(None), ctypes.c_size_t(0), ctypes.c_uint(LANDLOCK_CREATE_RULESET_VERSION),
        )
    except OSError as err:
        # ENOSYS: no Landlock in this kernel. EOPNOTSUPP: built but not
        # enabled at boot. EPERM: a seccomp profile hides the syscall.
        return 0, f"confinement: in-process file policy only (no Landlock: {err.strerror})"
    return abi, f"confinement: Landlock ABI {abi} plus the in-process file policy"


def landlock_abi():
    """The Landlock ABI version the fence runs under, 0 where there is none.

    Probed once per process, and on the first call that finds a kernel with
    Landlock, proved once as well: `_selftest` starts each interpreter under
    the fence and takes the kernel layer down (with a sentence in the log)
    if any of them cannot. Calls from the self-test's own children see the
    probed value and are fenced, which is the point of the test.
    """
    if _LANDLOCK["abi"] is None:
        _LANDLOCK["abi"], _LANDLOCK["note"] = _probe_landlock_abi()
        if _LANDLOCK["abi"]:
            failure = _selftest()
            if failure:
                _LANDLOCK["abi"] = 0
                _LANDLOCK["note"] = (
                    "confinement: in-process file policy only (Landlock is available "
                    f"but was not armed: {failure})"
                )
    return _LANDLOCK["abi"]


#: The variable, and its one value, that says this runner is the trusted
#: fresh-VM supervisor running one job. Only that supervisor sets it, in its
#: fixed environment; it is never accepted from a job or passed to a child.
ISOLATION_ENV = "RUNNER_ISOLATION"
MICROVM_ISOLATION = "single-job-microvm"


def confinement_note():
    """The one sentence about which fence holds, for the runner's log."""
    if os.environ.get(ISOLATION_ENV) == MICROVM_ISOLATION:
        return "confinement: one immutable job in a fresh microVM; language policy remains defence in depth"
    if not landlock_abi():
        return "confinement: kernel isolation unsupported; learner execution and previews are refused"
    return _LANDLOCK["note"]


ISOLATION_UNAVAILABLE = "The code runner cannot provide kernel isolation on this host. Your saved work is unchanged."


def isolation_status():
    if os.environ.get(ISOLATION_ENV) == MICROVM_ISOLATION:
        return {"status": "ok", "mechanism": MICROVM_ISOLATION}
    if landlock_abi():
        return {"status": "ok", "mechanism": "landlock"}
    return {"status": "unsupported", "mechanism": "none", "reason": "kernel-isolation-unavailable"}


def _selftest():
    """Start each interpreter under the fence. A sentence on failure, else None."""
    workspace = tempfile.mkdtemp(prefix="lsdlc-fence-")
    probes = [
        ("python", [
            sys.executable, "-I", "-S", "-B", "-c",
            "import json, os, sqlite3, tempfile\n"
            "tempfile.mkstemp()\n"
            "sqlite3.connect(os.environ['TASKTRACKR_DB']).close()\n"
            "pylib = os.environ.get('LSDLC_PYLIB')\n"
            "pylib and os.listdir(pylib)\n"
            "print('ok')",
        ], True),
    ]
    node = shutil.which(_node_bin())
    if node:
        probes.append(("node", [
            node, "-e", "require('fs').readdirSync(process.cwd()); console.log('ok')",
        ], False))
    esbuild = runtime_esbuild()
    if esbuild:
        probes.append(("esbuild", [esbuild, "--version"], False))
    try:
        for name, argv, limit_as in probes:
            code, stdout, stderr, kind = run_child(
                argv, workspace, 20, 512, limit_address_space=limit_as,
            )
            if kind != "ok" or code != 0:
                detail = (stderr or stdout or "").strip().splitlines()
                return f"{name} did not start under it: {detail[-1] if detail else f'exit {code}'}"
    except OSError as err:
        return f"the ruleset could not be applied: {err}"
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
    return None


def _prefix_of(program):
    """The install prefix a program runs from: two levels above the binary."""
    found = shutil.which(program) if program else None
    if not found:
        return None
    return os.path.dirname(os.path.dirname(os.path.realpath(found)))


def confinement_rules(workspace, extra_roots=(), programs=()):
    """What one child may reach, as (path, access, required) triples.

    Resolved in the parent, which is where a missing directory can be dropped
    rather than left to fail inside the child. The workspace and the extra
    roots are required; a system directory this image does not have is not.
    """
    abi = landlock_abi()
    every = landlock_rights(abi)
    device = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE
    if abi >= 5:
        device |= LANDLOCK_ACCESS_FS_IOCTL_DEV
    rules = []
    seen = set()

    def add(path, access, required=False):
        if not path:
            return
        path = os.path.realpath(path)
        if path in seen:
            return
        seen.add(path)
        if required or os.path.exists(path):
            rules.append((path, access, required))

    add(workspace, every, required=True)
    for root in extra_roots:
        add(root, every, required=True)
    for root in FENCE_SYSTEM_ROOTS:
        add(root, FENCE_READ)
    for root in (sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix):
        add(root, FENCE_READ)
    add(_prefix_of(sys.executable), FENCE_READ)
    for program in programs:
        add(_prefix_of(program), FENCE_READ)
    add(runtime_root(), FENCE_READ)
    for path in FENCE_DEVICE_FILES:
        add(path, device)
    return rules


def landlock_ruleset(workspace, extra_roots=(), programs=()):
    """A ruleset fd for one child, or None where the kernel layer is off.

    Built in the parent and handed to the preexec, so every path is opened
    where an error can be raised as one. The caller closes it after the spawn.
    """
    abi = landlock_abi()
    if not abi:
        return None
    attr = _RulesetAttr(landlock_rights(abi))
    fd = _syscall(
        LANDLOCK_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)),
        ctypes.c_uint(0),
    )
    try:
        for path, access, required in confinement_rules(workspace, extra_roots, programs):
            try:
                # O_PATH: a handle to the path, no read permission needed.
                # It is Linux-only, and so is everything that reaches here.
                parent = os.open(path, getattr(os, "O_PATH", os.O_RDONLY) | os.O_CLOEXEC)
            except OSError:
                if required:
                    raise
                continue
            try:
                rule = _PathBeneathAttr(access, parent)
                _syscall(
                    LANDLOCK_ADD_RULE, ctypes.c_int(fd), ctypes.c_uint(LANDLOCK_RULE_PATH_BENEATH),
                    ctypes.byref(rule), ctypes.c_uint(0),
                )
            except OSError:
                # A filesystem that cannot carry a rule (some pseudo
                # filesystems); the child simply does not get that path.
                if required:
                    raise
            finally:
                os.close(parent)
    except BaseException:
        os.close(fd)
        raise
    return fd


def landlock_enforce(ruleset_fd):
    """Restrict the calling process. Runs in the child, between fork and exec."""
    libc = _libc()
    if libc.prctl(
        ctypes.c_int(PR_SET_NO_NEW_PRIVS), ctypes.c_ulong(1),
        ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0),
    ) != 0:
        errno = ctypes.get_errno()
        raise OSError(errno, f"prctl(PR_SET_NO_NEW_PRIVS): {os.strerror(errno)}")
    _syscall(LANDLOCK_RESTRICT_SELF, ctypes.c_int(ruleset_fd), ctypes.c_uint(0))


def fenced_run(argv, workspace, programs=(), **kwargs):
    """subprocess.run for a tool the RUNNER starts in a workspace (esbuild).

    Not a sandboxed child (no rlimits, the caller's environment), but the same
    kernel fence: a bundle that resolved an import from a sibling workspace
    would carry that learner's file to this one's browser.
    """
    fence = landlock_ruleset(workspace, programs=programs)
    try:
        return subprocess.run(
            argv, cwd=workspace,
            preexec_fn=(lambda: landlock_enforce(fence)) if fence is not None else None,
            **kwargs,
        )
    finally:
        if fence is not None:
            os.close(fence)


# JavaScript test harness (Node). Mirrors the Python BOOTSTRAP: it defines a
# tiny test/assert API, best-effort blocks the network, loads the learner's test
# files (which require their implementation via CommonJS), and emits the same
# @@LSDLC_RESULT@@ JSON line the Python path does. Runs under the identical
# rlimit preexec, so isolation is language-independent.
#
# It runs the TypeScript front end too (a DOM harness of its own, not vitest,
# inside the sandbox). Two additions carry that: a case may return a
# promise, which is awaited one case at a time against a per-case deadline, and
# `spec.dom` installs a jsdom window and a fetch stub before the first test file
# loads. The TypeScript itself is compiled to CommonJS in the PARENT, by
# transform_typescript below, because this child cannot spawn esbuild.
JS_HARNESS = r'''
const assert = require('assert');
const fs = require('fs');
const path = require('path');
function blocked() { throw new Error('network access is disabled in the LearnSDLC sandbox'); }
try {
  const net = require('net');
  net.Socket.prototype.connect = blocked;
  net.connect = net.createConnection = blocked;
} catch (e) {}
try {
  const dns = require('dns');
  for (const k of Object.keys(dns)) if (typeof dns[k] === 'function') dns[k] = blocked;
} catch (e) {}
// Spawning a process (curl, sh, python) is the easiest way around the in-process
// network block, and no learner test has a reason to do it.
try {
  const cp = require('child_process');
  for (const k of Object.keys(cp)) if (typeof cp[k] === 'function') cp[k] = blocked;
} catch (e) {}
try { process.binding = blocked; } catch (e) {}

const ROOT = (function () { try { return fs.realpathSync(process.cwd()); } catch (e) { return process.cwd(); } })();
const HARNESS = (function () { try { return fs.realpathSync(__filename); } catch (e) { return __filename; } })();
const MAX_FRAMES = 5;
const SNIPPET_MAX = 160;
const SOURCES = new Map();
// One line of a V8 stack: "    at name (/abs/file.js:12:3)" or "    at /abs/file.js:12:3".
const AT_LINE = /^\s+at\s+(?:.*\s\()?(.+):(\d+):\d+\)?$/;

// The workspace is a throwaway temp directory, so its absolute path is a host
// detail, not something to publish: paths come back workspace-relative and
// anything outside the workspace (node internals, this harness) is dropped.
function relativise(file) {
  if (!file || file.startsWith('node:')) return null;
  let abs = file.startsWith('file://') ? file.slice('file://'.length) : file;
  if (!path.isAbsolute(abs)) return null;
  try { abs = fs.realpathSync(abs); } catch (e) {}
  if (abs === HARNESS || abs === ROOT || !abs.startsWith(ROOT + path.sep)) return null;
  return abs.slice(ROOT.length + 1);
}

function sourceLine(rel, line) {
  if (!SOURCES.has(rel)) {
    let lines = null;
    try { lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n'); } catch (e) {}
    SOURCES.set(rel, lines);
  }
  const lines = SOURCES.get(rel);
  const text = lines && lines[line - 1];
  return text ? text.trim().slice(0, SNIPPET_MAX) : '';
}

// Mirrors the Python harness's _workspace_frames: deepest frame first, which
// is the order V8 already writes, capped so a recursion error stays readable.
function workspaceFrames(stack) {
  const frames = [];
  if (typeof stack !== 'string') return frames;
  for (const raw of stack.split('\n')) {
    const m = AT_LINE.exec(raw);
    if (!m) continue;
    const rel = relativise(m[1]);
    if (rel === null) continue;
    const frame = { path: rel, line: Number(m[2]) };
    const snippet = sourceLine(rel, frame.line);
    if (snippet) frame.snippet = snippet;
    frames.push(frame);
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

// A message can carry the absolute workspace path ("Cannot find module …"),
// which the frames deliberately hide; strip it there too.
function redact(text) {
  return String(text).split(ROOT + path.sep).join('').split(ROOT).join('.');
}

function describeError(name, e, status) {
  const outcome = { name: String(name), status, message: redact((e && e.message) || e).slice(0, 500) };
  const frames = workspaceFrames(e && e.stack);
  if (frames.length) outcome.frames = frames;
  return outcome;
}

const cases = [];
// Queued, not run: main() below awaits them one at a time. A front end cannot
// be tested honestly without Testing Library's findBy* and waitFor, and both
// hand back a promise. Sequential, never parallel — the kill matrix reads case
// order, and it has to stay the order the pack wrote the tests in.
const pending = [];
function record(name, fn) { pending.push({ name, fn }); }

// One case's share of the run's own budget. A promise that never settles is
// then one errored case carrying a sentence, rather than a wall-clock kill that
// takes the whole result line — and every other case with it.
function withDeadline(promise, ms) {
  let timer;
  const seconds = Math.max(1, Math.round(ms / 1000));
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(
        'this test did not finish within ' + seconds + ' seconds; a promise it awaited never settled')),
      ms,
    );
    // Deliberately NOT unref'd. It is the only handle keeping the loop alive
    // while a promise that never settles is awaited, and an unref'd one let
    // node exit at once with no result line at all — found by running it.
  });
  return Promise.race([promise, deadline]).then(
    (value) => { clearTimeout(timer); return value; },
    (error) => { clearTimeout(timer); throw error; },
  );
}

// beforeEach/afterEach exist for one concrete reason: Testing Library registers
// its own cleanup through afterEach, and without it every render stays in the
// document and the second test that looks for a testid finds two of them. They
// are ordinary hooks as well, and a pack may use them as such.
const beforeEachHooks = [];
const afterEachHooks = [];
async function runHooks(hooks, deadlineMs) {
  for (const hook of hooks) {
    const r = hook();
    if (r && typeof r.then === 'function') await withDeadline(r, deadlineMs);
  }
}

// An exception raised outside the awaited chain — a React commit inside a
// jsdom event dispatch, a callback in a timer — is not on any try/catch's
// stack, and node's default handler would kill the child BEFORE the result
// line is printed: one component that throws during an async update would lose
// the whole run's cases rather than fail one of them. Routed into the case
// that is running, and recorded as its own case when none is.
let derail = null;
let printed = false;
function derailOrRecord(thrown) {
  const error = thrown instanceof Error ? thrown : new Error(String(thrown));
  if (derail) {
    const reject = derail;
    derail = null;
    reject(error);
    return;
  }
  if (printed) return;
  const outcome = describeError('an error outside any test', error, 'errored');
  outcome.durationMs = 0;
  cases.push(outcome);
}
process.on('uncaughtException', derailOrRecord);
process.on('unhandledRejection', derailOrRecord);

async function runOne(name, fn, deadlineMs) {
  const started = process.hrtime.bigint();
  let outcome;
  // Rejected by derailOrRecord if something throws off this stack while the
  // case is awaiting. Cleared on both exits, so a later throw is not blamed on
  // a case that has already finished.
  const derailed = new Promise((_resolve, reject) => { derail = reject; });
  try {
    await runHooks(beforeEachHooks, deadlineMs);
    const r = fn();
    // Awaited inside the same try, so a rejected assertion is still a failure
    // and a rejected anything-else is still an error: one rule for both.
    if (r && typeof r.then === 'function') await withDeadline(Promise.race([r, derailed]), deadlineMs);
    outcome = { name: String(name), status: 'passed' };
  } catch (e) {
    // Testing Library's element error counts as an assertion: "no element with
    // that testid" is the DOM saying the expectation was not met, which is a
    // failure. Without this every front-end expectation reads as `errored`,
    // where the same expectation on the Python side reads as `failed`, and a
    // learner comparing the two layers meets two different rules.
    const isAssert = e && (e.code === 'ERR_ASSERTION' || e instanceof assert.AssertionError
      || e.name === 'TestingLibraryElementError');
    outcome = describeError(name, e, isAssert ? 'failed' : 'errored');
  }
  // Not observable from outside — a rejection of a derail nobody races comes
  // back through unhandledRejection and is recorded anyway — but one trip
  // through the handler is the honest version of this.
  derail = null;
  // In its own try, and after a failure as well as after a pass: a case that
  // failed still has to hand the next one a clean document.
  try { await runHooks(afterEachHooks, deadlineMs); }
  catch (e) { process.stderr.write('an afterEach hook failed: ' + redact((e && e.stack) || e) + '\n'); }
  outcome.durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  cases.push(outcome);
}
// Node's assert describes both values when a comparison fails, and it does it
// by inspecting them to a depth of 1000 with no length cap. Any jsdom node
// reaches the whole document, its window and every listener from itself, so
// describing one never finishes: the child's memory climbs by about a
// gigabyte a second until the kernel kills it, and the run comes back
// `exitKind: "memory"` with no result line and nothing on stderr. Passing a
// message of our own does not stop it — the values still reach the error.
//
// That is the shape of the DOM assertion this pack and every learner writes:
//   assert.strictEqual(screen.queryByTestId('overdue-badge'), null)
// so a test that correctly caught the bug reads as "the runner ran out of
// memory" instead of as a failure. A Mac has the spare gigabytes to finish
// the string and hides it; the container the class runs on does not.
//
// So the four shallow comparisons answer for themselves when a DOM node is
// involved. The predicate is node's own — Object.is for strictEqual, == for
// equal — and the exception is node's own AssertionError with node's own
// `code`, so a failure is still a failure and the harness still tells it from
// an error. Only what the error carries changes: a one-line description of
// the element instead of the element itself.
const isDomNode = (value) =>
  !!value && typeof value === 'object' && typeof value.nodeType === 'number';
const describeDom = (value) => {
  if (!isDomNode(value)) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return JSON.stringify(value.slice(0, 120));
    if (typeof value === 'object') return Object.prototype.toString.call(value);
    return String(value);
  }
  const tag = String(value.nodeName || 'node').toLowerCase();
  const testid = value.getAttribute ? value.getAttribute('data-testid') : null;
  const text = typeof value.textContent === 'string' ? value.textContent.slice(0, 60) : '';
  return `<${tag}${testid ? ` data-testid="${testid}"` : ''}>${text ? ' ' + text : ''}`;
};
const SHALLOW = {
  strictEqual: { holds: (a, b) => Object.is(a, b), reads: 'is' },
  notStrictEqual: { holds: (a, b) => !Object.is(a, b), reads: 'is not' },
  // eslint-disable-next-line eqeqeq
  equal: { holds: (a, b) => a == b, reads: 'is' },
  // eslint-disable-next-line eqeqeq
  notEqual: { holds: (a, b) => a != b, reads: 'is not' },
};
const domSafeAssert = Object.assign(function (...args) { return assert(...args); }, assert);
for (const [name, rule] of Object.entries(SHALLOW)) {
  if (typeof assert[name] !== 'function') continue;
  domSafeAssert[name] = function (actual, expected, message) {
    if (!isDomNode(actual) && !isDomNode(expected)) {
      return assert[name](actual, expected, message);
    }
    if (rule.holds(actual, expected)) return;
    const shown = describeDom(actual);
    const wanted = describeDom(expected);
    throw new assert.AssertionError({
      message: message === undefined ? `${shown} ${rule.reads} ${wanted}` : String(message),
      actual: shown,
      expected: wanted,
      operator: name,
      stackStartFn: domSafeAssert[name],
    });
  };
}
globalThis.assert = domSafeAssert;
globalThis.test = record;
globalThis.it = record;
globalThis.describe = function (_name, fn) { fn(); };
globalThis.beforeEach = function (fn) { beforeEachHooks.push(fn); };
globalThis.afterEach = function (fn) { afterEachHooks.push(fn); };

// The graded artefacts arrive in a directory outside the workspace. Load every
// one of them, delete the directory, and map the workspace path each would have
// had onto the copy that now exists only in require.cache: a test that requires
// '../taskmanager' gets the module, and one that reads 'taskmanager.js' off disk
// gets ENOENT. Runs before any test file is loaded, so the window in which the
// files exist contains no learner code at all.
// The honest limit: a module that has to run can still be read back out of the
// runtime (an exported function prints its own source). This closes the file
// oracle, which is the one a test can use in three lines; not that one.
function sealGraded(dir) {
  if (!dir) return;
  let root = dir;
  try { root = fs.realpathSync(dir); } catch (e) {}
  const Module = require('module');
  // absolute path the file WOULD have had in the workspace -> where it really is
  const graded = new Map();
  (function walk(abs) {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else graded.set(path.join(ROOT, path.relative(root, child)), child);
    }
  })(root);
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (request.startsWith('.') || path.isAbsolute(request)) {
      const from = parent && parent.filename ? path.dirname(parent.filename) : ROOT;
      const abs = path.resolve(from, request);
      // Checked before the real resolver, not after it: a workspace file of the
      // same name must not shadow the implementation being graded.
      for (const candidate of [abs, abs + '.js', abs + '.json', path.join(abs, 'index.js')]) {
        if (graded.has(candidate)) return graded.get(candidate);
      }
      // The other direction: a graded file importing a WORKSPACE file relatively.
      // The graded tree is a mirror of the workspace, so the same path from ROOT
      // is what './lib/overdue' meant when it was written beside the learner's
      // code. Without this the require throws inside the seal and the run prints
      // no result line at all — no cases to read and nothing to click.
      if (abs.startsWith(root + path.sep)) {
        const mapped = path.join(ROOT, path.relative(root, abs));
        // A graded file importing another graded file still gets the graded one:
        // the map is keyed by the workspace path each of them WOULD have had.
        for (const candidate of [mapped, mapped + '.js', mapped + '.json',
                                 path.join(mapped, 'index.js')]) {
          if (graded.has(candidate)) return graded.get(candidate);
        }
        return resolve.call(this, mapped, parent, ...rest);
      }
    }
    return resolve.call(this, request, parent, ...rest);
  };
  for (const file of graded.values()) if (/\.(js|json)$/.test(file)) require(file);
  // Bottom-up by hand, not fs.rmSync: Node's rm tries rmdir(root) FIRST and
  // only descends on ENOTEMPTY. Under the kernel fence the directory is
  // read-write but deleting it needs a right on its PARENT (/tmp), which the
  // fence never grants, so rmSync gives up with EACCES before it unlinks a
  // single file — and every graded file stays readable. The files are what
  // the seal is for; the empty root directory surviving is harmless.
  (function clear(abs) {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) { clear(child); try { fs.rmdirSync(child); } catch (e) {} }
      else fs.unlinkSync(child);
    }
  })(root);
  try { fs.rmdirSync(root); } catch (e) {}
  // A graded file still on disk is not a run: a suite could read the answer
  // key. Thrown, so the run prints no result line rather than a false score.
  for (const file of graded.values()) {
    if (fs.existsSync(file)) throw new Error('graded artefact still on disk after the seal: ' + path.basename(file));
  }
}

// The DOM half of the harness, installed only for a TypeScript run: a jsdom
// window on globalThis, so a React component test meets the globals a browser
// would give it, and a fetch stub, so a unit test that reaches for the network
// says so rather than hanging until the wall clock.
let domWindow = null;
function installDom(fetchStubs) {
  const { JSDOM, VirtualConsole } = require('jsdom');
  // The page's own console still reaches the learner; jsdom's second report of
  // an uncaught error does not, because React re-throws that same error into
  // the test, where it becomes the case's message and its frames. Without this
  // one render failure prints thirty lines of React internals.
  const virtualConsole = new VirtualConsole().sendTo(console, { omitJSDOMErrors: true });
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'http://localhost/', pretendToBeVisual: true, virtualConsole },
  );
  domWindow = dom.window;
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
                   'CustomEvent', 'getComputedStyle', 'requestAnimationFrame',
                   'cancelAnimationFrame', 'MutationObserver', 'localStorage', 'sessionStorage']) {
    globalThis[k] = dom.window[k];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = stubFetch(fetchStubs || {});
}

// Answers from the map the phase declared and refuses everything else. A unit
// test that really needs an HTTP call is a test of the API layer, and that
// layer is graded by the other run.
function stubFetch(stubs) {
  return function fetch(input) {
    const raw = (input && input.url) || String(input);
    const keys = [raw];
    try {
      const url = new URL(raw, 'http://localhost/');
      keys.push(url.pathname + url.search, url.pathname);
    } catch (e) {}
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(stubs, key)) continue;
      const text = JSON.stringify(stubs[key]);
      return Promise.resolve({
        ok: true, status: 200, statusText: 'OK', url: raw,
        headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: () => Promise.resolve(JSON.parse(text)),
        text: () => Promise.resolve(text),
      });
    }
    return Promise.reject(new Error(
      'this test made a network call; stub it or test the API layer directly'));
  };
}

// A testPath may name a directory — the web run's is `web/src` — and node
// cannot require one. Walk it for test files, newest extension wins: after the
// transform a suite exists as both x.test.tsx and the x.test.js compiled from
// it, and requiring both would run every case twice. Sorted, because the kill
// matrix reads case order and it has to be the same order every run.
const TEST_FILE = /\.test\.(tsx|ts|jsx|js)$/;
const TEST_SOURCE = /\.test\.tsx?$/;
function testFilesUnder(dir) {
  const found = [];
  (function walk(abs) {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (TEST_FILE.test(entry.name)) found.push(path.relative(ROOT, child));
    }
  })(dir);
  // esbuild wrote x.test.js beside x.test.tsx, and requiring both would run
  // every case twice. The source wins, whatever order the directory was read
  // in, and it is the name the learner sees in the explorer.
  const sources = new Set(found.filter((rel) => TEST_SOURCE.test(rel)).map((rel) => rel.replace(TEST_FILE, '')));
  return found
    .filter((rel) => TEST_SOURCE.test(rel) || !sources.has(rel.replace(TEST_FILE, '')))
    .sort();
}

const spec = JSON.parse(process.argv[2]);
if (spec.dom) installDom(spec.fetchStubs);
sealGraded(spec.gradedDir);
const testPaths = [];
for (const rel of spec.testPaths) {
  const abs = path.resolve(process.cwd(), rel);
  let isDirectory = false;
  try { isDirectory = fs.statSync(abs).isDirectory(); } catch (e) {}
  if (isDirectory) testPaths.push(...testFilesUnder(abs));
  else testPaths.push(rel);
}
for (const rel of testPaths) {
  // esbuild wrote the CommonJS beside the source it came from, and the source
  // stays where it is: the inline source map points back at it, so a frame
  // still names the .tsx the learner opened.
  const target = rel.replace(/\.tsx?$/, '.js');
  try {
    require(path.resolve(process.cwd(), target));
  } catch (e) {
    // A file that will not even load is an errored suite, not an empty one:
    // with no case recorded the run would report zero failures and pass. It is
    // queued rather than pushed so the cases stay in the pack's own order.
    process.stderr.write(redact((e && e.stack) || e) + '\n');
    pending.push({ name: rel, error: e });
  }
}
(async function main() {
  const deadlineMs = Math.max(1000, Math.round(((spec.timeoutSeconds || 10) * 1000) / 4));
  for (const item of pending) {
    if (item.error) {
      const outcome = describeError(item.name, item.error, 'errored');
      outcome.durationMs = 0;
      cases.push(outcome);
    } else {
      await runOne(item.name, item.fn, deadlineMs);
      // One turn of the event loop between cases, so a timer a finished case
      // left behind fires HERE, where derail is null and it is recorded as its
      // own case, rather than being blamed on the next case or swallowed.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  const by = (s) => cases.filter((c) => c.status === s).length;
  console.log('@@LSDLC_RESULT@@' + JSON.stringify({
    total: cases.length, passed: by('passed'), failed: by('failed'), errored: by('errored'), cases,
  }));
  printed = true;
  try { if (domWindow) domWindow.close(); } catch (e) {}
  // A test that left a timer or a socketless open handle behind would hold the
  // event loop open until the wall clock killed the run, and the result line
  // above would never be read. Unref'd, so a run that ends cleanly still ends
  // the moment it is done, and 250 ms is long enough for the line to flush.
  const bail = setTimeout(() => process.exit(0), 250);
  if (bail.unref) bail.unref();
})();
'''

# The security half of every Python harness, in one string.
#
# The socket, exec and import blocklists, and the two helpers that keep the
# workspace's absolute path out of everything we hand back. Both bootstraps
# embed this constant rather than carrying a copy each: two divergent copies of
# a blocklist is the defect this arrangement exists to prevent, because a rule
# tightened in one copy and forgotten in the other is a hole nobody sees until
# somebody uses it.
_BLOCKS_HEAD = r'''
import _posixsubprocess
import _socket
import os
import posix
import socket
import sys
import traceback


def _blocked(*args, **kwargs):
    raise RuntimeError("network access is disabled in the LearnSDLC sandbox")


def _no_exec(*args, **kwargs):
    raise RuntimeError("spawning processes is disabled in the LearnSDLC sandbox")


class _BlockedSocket:
    """What socket.socket becomes: a class that cannot be instantiated.

    A class rather than a plain function, and that is not a detail. `ssl.py`
    does `from socket import socket` and then `class SSLSocket(socket)`, and
    werkzeug imports ssl transitively through `werkzeug.serving`, so with a
    function in place of the class the whole of Flask is unimportable inside the
    sandbox — the error a learner would have seen is
    "TypeError: function() argument 'code' must be code, not str", four frames
    deep in the standard library. An inert base class costs nothing and is the
    stronger choice: ssl's subclass inherits from something that raises, so
    the real socket type is not reachable through it either.
    """

    def __new__(cls, *args, **kwargs):
        _blocked()


'''

# The graded socket policy: no socket at all. One of two chunks that can sit in
# the middle of a bootstrap: the live preview substitutes the loopback policy
# below for exactly this, and nothing else about the sandbox changes.
_SOCKETS_BLOCKED = r'''
# socket.socket is only a subclass of _socket.socket, so patching the public
# module alone leaves `import _socket; _socket.socket()` wide open. Patch every
# constructor path in both modules.
for _mod in (socket, _socket):
    for _name in ("socket", "SocketType"):
        if hasattr(_mod, _name):
            setattr(_mod, _name, _BlockedSocket)
    for _name in (
        "socketpair", "fromfd", "dup",
        "getaddrinfo", "gethostbyname", "gethostbyaddr", "create_connection", "create_server",
    ):
        if hasattr(_mod, _name):
            setattr(_mod, _name, _blocked)

# Which modules may not be imported afresh. It lives with the socket policy
# because that is the half a preview changes; the finder that reads it is in the
# tail, shared by both.
_BLOCKED_IMPORTS = {"_socket", "_posixsubprocess", "posix", "ctypes", "_ctypes"}
'''

# Everything both policies share: no exec, no fresh import of the modules the
# policy above patched, and the two helpers that keep the workspace's absolute
# path out of what we hand back.
_BLOCKS_TAIL = r'''
# os.* are the same builtin objects as posix.*, so both modules get patched or
# `import posix; posix.execv(...)` still works.
for _mod in (os, posix):
    for _name in dir(_mod):
        if _name.startswith(("exec", "spawn", "posix_spawn")) or _name in ("system", "popen"):
            setattr(_mod, _name, _no_exec)
_posixsubprocess.fork_exec = _no_exec


class _Blocklist:
    """Meta-path finder: refuse a fresh import of the modules patched above
    (deleting them from sys.modules would otherwise re-import pristine
    copies) and of ctypes, which reaches libc's socket()/execve() directly."""

    names = _BLOCKED_IMPORTS

    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in self.names:
            raise ImportError(f"{name} is not available in the LearnSDLC sandbox")
        return None


sys.meta_path.insert(0, _Blocklist())


_ROOT = os.path.realpath(os.getcwd())
_MAX_FRAMES = 5
_SNIPPET_MAX = 160


def _workspace_path(filename):
    """A frame's file as a workspace-relative path, or None if it is not ours.

    The workspace is a throwaway temp directory, so its absolute path is a
    host detail no learner should see. realpath on both sides keeps the prefix
    test honest where /var is a symlink to /private/var (the macOS dev
    runner), and the isfile check drops synthetic filenames — this bootstrap
    runs from -c, so its own frames read "<string>".
    """
    if not filename:
        return None
    resolved = os.path.realpath(os.path.join(_ROOT, filename))
    prefix = _ROOT + os.sep
    if not resolved.startswith(prefix) or not os.path.isfile(resolved):
        return None
    return resolved[len(prefix):]


def _workspace_frames(tb):
    """The traceback as frames in the learner's own files, deepest first.

    unittest's and the harness's frames fall outside the workspace and are
    dropped, so what is left is the path the learner's code took to the
    failure. Capped so a recursion error cannot flood the report.
    """
    frames = []
    for summary in reversed(traceback.extract_tb(tb)):
        rel = _workspace_path(summary.filename)
        if rel is None:
            continue
        frame = {"path": rel, "line": summary.lineno or 0}
        snippet = (summary.line or "").strip()
        if snippet:
            frame["snippet"] = snippet[:_SNIPPET_MAX]
        frames.append(frame)
        if len(frames) == _MAX_FRAMES:
            break
    return frames


# ---------------------------------------------------------------- the files
#
# What this process may open, list, make or remove: its own workspace (the
# cwd) and the directories the runner named in LSDLC_FS_ROOTS (a graded run's
# sealed directory, deleted before any learner code loads) read-write; the
# interpreter, the baked library and the system directories read-only; four
# device files. Every other path — /tmp above all, where every other learner's
# run lives — is refused, and refused by name so a learner reads why.
#
# This is the in-process half of the fence; the kernel half is Landlock, which
# the runner arms where the kernel has it. Both hold the same rule. Like every
# other block in this file it patches the names Python code reaches these
# calls through, on both `os` and `posix`, and the import blocklist above keeps
# a fresh copy of the patched modules out of reach.
import builtins
import io
import _io


def _fs_real(path):
    return os.path.realpath(path)


_FS_WRITE = {_ROOT} | {
    _fs_real(p) for p in os.environ.get("LSDLC_FS_ROOTS", "").split(os.pathsep) if p
}
_FS_READ = {
    _fs_real(p) for p in (
        "/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc",
        sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix,
        os.path.dirname(os.path.dirname(_fs_real(sys.executable))),
        os.environ.get("LSDLC_PYLIB", ""),
    ) if p
}
_FS_DEVICES = {_fs_real(p) for p in ("/dev/null", "/dev/zero", "/dev/urandom", "/dev/random")}
_FS_WRITE_MODES = frozenset("wax+")
_FS_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND


def _fs_refuse(path):
    raise PermissionError(
        "the LearnSDLC sandbox keeps a run inside its own workspace: "
        f"{os.fsdecode(os.fspath(path))!r} is outside it"
    )


def _fs_resolve(path):
    """The absolute, symlink-resolved path a call names; None for an fd."""
    if path is None or isinstance(path, int):
        return None
    return _fs_real(os.path.join(os.getcwd(), os.fsdecode(os.fspath(path))))


def _fs_within(resolved, roots):
    return any(resolved == root or resolved.startswith(root + os.sep) for root in roots)


def _fs_check(path, write=False, dir_fd=None):
    if dir_fd is not None:
        # A path relative to a directory descriptor is a path this check
        # cannot see. Nothing in a learner's program needs one; shutil is told
        # below not to use them either.
        raise PermissionError("dir_fd is not available in the LearnSDLC sandbox")
    resolved = _fs_resolve(path)
    if resolved is None:
        return
    if _fs_within(resolved, _FS_WRITE) or resolved in _FS_DEVICES:
        return
    if not write and _fs_within(resolved, _FS_READ):
        return
    _fs_refuse(path)


def _fs_mode_writes(mode):
    return isinstance(mode, str) and bool(_FS_WRITE_MODES & set(mode))


_fs_open = builtins.open


def open(file, mode="r", buffering=-1, encoding=None, errors=None, newline=None,
         closefd=True, opener=None):
    _fs_check(file, write=_fs_mode_writes(mode))
    return _fs_open(file, mode, buffering, encoding, errors, newline, closefd, opener)


_fs_open_code = _io.open_code


def open_code(path):
    _fs_check(path)
    return _fs_open_code(path)


class FileIO(_io.FileIO):
    def __init__(self, file, mode="r", closefd=True, opener=None):
        _fs_check(file, write=_fs_mode_writes(mode))
        super().__init__(file, mode, closefd, opener)


builtins.open = io.open = _io.open = open
io.open_code = _io.open_code = open_code
io.FileIO = _io.FileIO = FileIO


def _guard_fs(name, write, params):
    """Patch one os/posix call whose `params` (index, keyword) name paths."""
    original = getattr(os, name)

    def guarded(*args, **kwargs):
        dir_fd = kwargs.get("dir_fd")
        for index, keyword in params:
            if index < len(args):
                _fs_check(args[index], write=write, dir_fd=dir_fd)
            elif keyword in kwargs:
                _fs_check(kwargs[keyword], write=write, dir_fd=dir_fd)
        if dir_fd is not None:
            _fs_check(None, dir_fd=dir_fd)
        return original(*args, **kwargs)

    guarded.__name__ = guarded.__qualname__ = name
    for _mod in (os, posix):
        if hasattr(_mod, name):
            setattr(_mod, name, guarded)


# Not readlink: os.path.realpath, which every check below runs, reads links
# through it, and a link's target is a name rather than a file — what it names
# is checked when something opens it.
for _name in ("listdir", "scandir", "chdir"):
    _guard_fs(_name, False, ((0, "path"),))
for _name in ("mkdir", "rmdir", "remove", "unlink", "truncate", "utime", "chmod", "chown",
              "lchmod", "lchown", "chflags", "lchflags", "mkfifo", "mknod"):
    if hasattr(os, _name):
        _guard_fs(_name, True, ((0, "path"),))
for _name in ("rename", "replace", "link"):
    _guard_fs(_name, True, ((0, "src"), (1, "dst")))
# A symlink's target is text until something opens it, and then it is checked
# as what it resolves to; the link itself has to land inside the workspace.
_guard_fs("symlink", True, ((1, "dst"),))

_fs_os_open = os.open


def _os_open(path, flags, mode=0o777, *, dir_fd=None):
    _fs_check(path, write=bool(flags & _FS_WRITE_FLAGS), dir_fd=dir_fd)
    return _fs_os_open(path, flags, mode, dir_fd=dir_fd)


_os_open.__name__ = _os_open.__qualname__ = "open"
os.open = posix.open = _os_open

# shutil.rmtree prefers the dir_fd forms where os says it supports them, and
# os.supports_dir_fd holds the functions os had at import — not these. Said
# outright rather than left to that coincidence: the seal's rmtree is what
# deletes the graded directory before a learner's code loads.
import shutil
shutil._use_fd_functions = False

# tokenize binds builtins.open at import, and it was imported (through
# traceback) before this ran; linecache reads source through it.
import tokenize
tokenize._builtin_open = open

try:
    import sqlite3
    import _sqlite3
except ImportError:  # a build without sqlite has nothing to guard
    sqlite3 = None
else:
    _fs_connect = sqlite3.connect

    def _db_path(database, uri):
        if database is None or isinstance(database, int):
            return None
        text = os.fsdecode(os.fspath(database))
        if uri and text.startswith("file:"):
            text = text[5:].split("?", 1)[0]
            if text.startswith("//"):
                text = text[2:]
                if not text.startswith("/"):
                    # file://localhost/x names /x; the authority is not a path.
                    text = "/" + text.partition("/")[2]
        return None if text in ("", ":memory:") else text

    def connect(database, *args, **kwargs):
        uri = kwargs.get("uri", args[6] if len(args) > 6 else False)
        target = _db_path(database, uri)
        if target is not None:
            _fs_check(target, write=True)
        return _fs_connect(database, *args, **kwargs)

    sqlite3.connect = sqlite3.dbapi2.connect = _sqlite3.connect = connect

# Two more modules whose fresh import would hand back a pristine copy of what
# was just patched: _io (open, FileIO, open_code) and _sqlite3 (connect). Both
# are loaded now, and a module in sys.modules is never re-imported, so this
# only closes the `del sys.modules[...]` route. The finder reads the same set.
_BLOCKED_IMPORTS |= {"_io", "_sqlite3"}

'''

# The graded bootstraps' security half: no socket, no exec, no
# fresh import of the modules those two patches rely on.
BLOCKS = _BLOCKS_HEAD + _SOCKETS_BLOCKED + _BLOCKS_TAIL


# The live preview's socket policy, and the ONE substitution PREVIEW_BOOTSTRAP
# makes: this chunk replaces _SOCKETS_BLOCKED and nothing else moves.
#
# The learner's own app has to listen on a socket, so "no sockets" cannot be the
# rule here. What it becomes is "loopback, and only loopback": the address of
# every connect, bind and datagram send is checked against 127.0.0.1, ::1 and
# the workspace's own directory, and the resolver answers for localhost and
# refuses every other name, so a hostname never becomes a route. Everything
# else (exec, spawn, ctypes, the meta-path finder) is the tail above,
# unchanged and shared.
#
# `sendto`/`sendmsg` are wrapped as well as `connect`, and that is not padding:
# a datagram socket never connects, so an unwrapped `sendto` would be a working
# route off the machine past every other check in this file.
#
# The honest statement, which docs/production-runbook.md repeats: this is a
# second line of defence and can be unwound by code in the same interpreter.
# What actually holds is where it runs: the runner container is
# `network_mode: none`, so the namespace has a loopback device and nothing else.
_SOCKETS_LOOPBACK = r'''
_LOOPBACK = {socket.AF_INET: "127.0.0.1", socket.AF_INET6: "::1"}
_RESOLVES = {"localhost", "127.0.0.1", "::1"}


def _refuse(call, address):
    raise PermissionError(
        f"the LearnSDLC sandbox only allows loopback: {call}({address!r}) is not "
        "127.0.0.1, ::1 or a path inside this workspace"
    )


def _check_unix(call, address):
    # A str path inside the workspace. Bytes and the abstract namespace (a
    # leading NUL on Linux) are refused outright rather than decoded: neither is
    # something a learner's app needs, and both are ways to name a socket this
    # check cannot see.
    if not isinstance(address, str) or not address or address.startswith("\0"):
        _refuse(call, address)
    root = os.path.realpath(os.getcwd())
    target = os.path.realpath(os.path.join(root, address))
    # The parent, because bind names a file that does not exist yet. Inside
    # means the workspace itself or a path under it after a separator, the rule
    # _fs_within applies to files, so "<workspace>x" beside it is outside.
    parent = os.path.realpath(os.path.dirname(target))
    if target != root and not (parent == root or parent.startswith(root + os.sep)):
        _refuse(call, address)


def _check(call, sock, address):
    family = getattr(sock, "family", None)
    if family == getattr(socket, "AF_UNIX", None):
        _check_unix(call, address)
        return
    if family not in _LOOPBACK:
        _refuse(call, address)
    if not isinstance(address, tuple) or not address:
        _refuse(call, address)
    if address[0] != _LOOPBACK[family]:
        # Exact equality, so "0.0.0.0", "", "::" and every routable address are
        # one rule and not four: a wildcard bind is what would put a learner's
        # app on the classroom LAN.
        _refuse(call, address)


def _addresses(name, args):
    """Where the address sits in this call's arguments.

    sendto has two shapes — sendto(data, address) and sendto(data, flags,
    address) — and in both the address is last, so reading a fixed index would
    check an integer flag in one of them and let the address through.
    """
    if name in ("connect", "connect_ex", "bind"):
        return args[:1]
    if name == "sendto":
        return args[-1:] if len(args) >= 2 else ()
    if name == "sendmsg":
        return args[3:4]
    return ()


def _guard_raw(cls, name):
    original = getattr(cls, name)

    def guarded(self, *args, **kwargs):
        for address in _addresses(name, args):
            _check(name, self, address)
        return original(self, *args, **kwargs)

    guarded.__name__ = name
    setattr(cls, name, guarded)


def _guard(name):
    _guard_raw(socket.socket, name)


# connect, connect_ex and bind carry the address; a datagram socket never
# connects, so sendto and sendmsg are the calls that would otherwise be a
# working route off the machine.
for _name in ("connect", "connect_ex", "bind", "sendto", "sendmsg"):
    _guard(_name)


def _getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    if host not in _RESOLVES:
        _refuse("getaddrinfo", host)
    if isinstance(port, str):
        port = int(port) if port.isdigit() else _refuse("getaddrinfo", port)
    port = port or 0
    kind = type or socket.SOCK_STREAM
    answers = []
    if host != "::1" and family in (0, socket.AF_INET):
        answers.append((socket.AF_INET, kind, proto, "", ("127.0.0.1", port)))
    if host != "127.0.0.1" and family in (0, socket.AF_INET6):
        answers.append((socket.AF_INET6, kind, proto, "", ("::1", port, 0, 0)))
    if not answers:
        _refuse("getaddrinfo", host)
    return answers


def _gethostbyname(host):
    if host not in _RESOLVES:
        _refuse("gethostbyname", host)
    return "127.0.0.1"


def _gethostbyaddr(host):
    if host not in _RESOLVES:
        _refuse("gethostbyaddr", host)
    return ("localhost", [], ["127.0.0.1"])


# The C type's own methods cannot be patched, and `_socket.socket()` would
# otherwise hand back a socket with none of the guards above. A subclass carries
# them instead. It cannot be `socket.socket` itself: socket.py's __init__ calls
# `_socket.socket.__init__` through this very attribute, so pointing it at the
# Python class makes every socket construction recurse until the stack ends.
class _GuardedRawSocket(_socket.socket):
    pass


for _name in ("connect", "connect_ex", "bind", "sendto", "sendmsg"):
    _guard_raw(_GuardedRawSocket, _name)

for _mod in (socket, _socket):
    for _name in ("socket", "SocketType"):
        if _mod is _socket and hasattr(_mod, _name):
            setattr(_mod, _name, _GuardedRawSocket)
    for _name in ("socketpair", "fromfd", "dup", "create_server"):
        if hasattr(_mod, _name):
            setattr(_mod, _name, _blocked)
    for _name, _fn in (
        ("getaddrinfo", _getaddrinfo),
        ("gethostbyname", _gethostbyname),
        ("gethostbyaddr", _gethostbyaddr),
    ):
        if hasattr(_mod, _name):
            setattr(_mod, _name, _fn)

# create_connection is left alone deliberately: it is what http.client and
# urllib take, and every capability it has is one of the two wrapped calls
# underneath it — it resolves through the resolver above and connects through
# the guarded connect.

# The same list as the graded policy. `posix` and `_socket` stay refused: a
# WSGI server might be expected to need them, and the Flask test in
# test_preview_bootstrap.py proves it does not, so the stricter list stands.
_BLOCKED_IMPORTS = {"_socket", "_posixsubprocess", "posix", "ctypes", "_ctypes"}
'''


# What turns the policy into a launcher: run the pack's own script as if it had
# been started with `python3 api/main.py`, under the blocks above.
#
# Not `-I`, so the workspace is sys.path[0] and PYTHONPATH still carries the
# pre-baked library the app imports flask from; `-S`, so the only other library
# directory is that one and an app on a laptop runs against the same flask as an
# app in the container. Line buffering because the console pane reads this
# child's stdout a line at a time, and a fully buffered pipe would show a
# learner nothing until their app stopped.
_PREVIEW_MAIN = r'''
import runpy
import threading


def _arm_deadline():
    """Stop this process at LSDLC_PREVIEW_SECONDS, watched or not.

    Every other bound on a preview — the idle sweep, the hard cap, the byte
    budget — is enforced by app_session.sweep_once in the runner process. Kill
    the runner rather than shut it down and none of them is enforced any more:
    this child is reparented to init, sits in accept() spending no CPU, so
    RLIMIT_CPU never fires either, and it lives until the machine is rebooted.

    So the deadline is armed here as well, inside the child, where nothing
    outside it can disarm it. It is deliberately LATER than the supervisor's own
    hard cap (the runner adds a grace before passing it in), so a supervised
    session is always stopped by the supervisor and reports "expired"; this only
    ever fires when there is nobody left to do it.
    """
    try:
        seconds = int(os.environ.get("LSDLC_PREVIEW_SECONDS", "") or 0)
    except ValueError:
        seconds = 0
    if seconds <= 0:
        return

    def _stop():
        print(
            "the preview reached its %d second limit and stopped itself" % seconds,
            file=sys.stderr,
            flush=True,
        )
        os._exit(75)

    timer = threading.Timer(seconds, _stop)
    timer.daemon = True
    timer.start()


sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)
_arm_deadline()

_pylib = os.environ.get("LSDLC_PYLIB")
if _pylib and _pylib not in sys.path:
    sys.path.append(_pylib)

if len(sys.argv) < 2:
    raise SystemExit("the preview bootstrap needs a script to run")
_script = sys.argv[1]
sys.argv = sys.argv[1:]
runpy.run_path(_script, run_name="__main__")
'''

#: The environment variable the preview child reads its own deadline from, in
#: seconds. Set by `app_session.start` after the pack's own environment, so a
#: pack cannot lengthen or remove it; absent, the child arms no deadline of its
#: own.
PREVIEW_DEADLINE_ENV = "LSDLC_PREVIEW_SECONDS"

#: How much longer the child's own deadline is than the supervisor's hard cap.
#: The sweeper ticks every app_session.SWEEP_INTERVAL_SECONDS (5), so 30 leaves
#: the supervisor every chance to stop a session first and report `expired`.
PREVIEW_DEADLINE_GRACE_SECONDS = 30

#: The program the learner's own app runs under. One substitution against the
#: graded blocks (the socket policy), plus the launcher.
PREVIEW_BOOTSTRAP = _BLOCKS_HEAD + _SOCKETS_LOOPBACK + _BLOCKS_TAIL + _PREVIEW_MAIN


def preview_argv(command):
    """The argv that runs a pack's preview command under PREVIEW_BOOTSTRAP.

    Only python3. The loader lets a pack name `node` as well, and a node child
    would start with no policy at all; the JavaScript blocks in this file are a
    test harness, not a launcher, so a node service could spawn, read and
    connect freely. Refusing it here is a smaller gap than shipping it: no pack
    in the product declares one, and the sentence says exactly what is missing.
    """
    if not command:
        raise ValueError("the preview service has no command")
    if command[0] not in ("python3", "python"):
        raise ValueError(
            f"the preview supervisor can only start a python3 service, not {command[0]!r}"
        )
    if len(command) < 2:
        raise ValueError("the preview service command names no script")
    return [sys.executable, "-S", "-B", "-c", PREVIEW_BOOTSTRAP, *command[1:]]


# The other half both harnesses share: import every graded artefact, then delete
# the directory it came in. Same reason as BLOCKS: the seal is what stops a
# learner's suite from reading the implementation it is scored against, and one
# copy is the only way it stays true of both harnesses.
SEAL = r'''
import importlib
import os
import shutil


def _module_name(rel):
    """tasktrackr/manager.py -> tasktrackr.manager, tasktrackr/__init__.py -> tasktrackr."""
    dotted = rel[:-3].replace(os.sep, ".")
    return dotted[: -len(".__init__")] if dotted.endswith(".__init__") else dotted


def _seal_graded(root):
    """Import every graded module, then delete the directory that held it.

    The graded artefacts decide the learner's score, and a suite that can read
    them knows which bug to look for without writing a test that finds it. They
    are never written into the workspace: they arrive here, outside it, and this
    runs before any learner module is imported, so by the time the learner's
    tests load there is nothing left on disk for them to open. What survives is
    the imported module, which is what their tests are supposed to exercise.

    A graded artefact that will not import is a pack bug. It is raised rather
    than swallowed: a dead harness prints no result line, and no result line is
    explicitly not a kill, where a swallowed ImportError would be one — every
    suite would "kill" a mutant it could not even load.

    The honest limit: a module that has to execute can still be read back out of
    the runtime, by dis or by a function's own bytecode. This closes the file
    oracle, which is the one a test can use in three lines; not that one.
    """
    modules = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in sorted(filenames):
            if not name.endswith(".py"):
                continue
            rel = os.path.relpath(os.path.join(dirpath, name), root)
            modules[rel] = importlib.import_module(_module_name(rel))
    for rel, module in modules.items():
        # A package can exist in both roots — tests/ holds the learner's visible
        # suite and the graded hidden one. The graded copy is imported first, so
        # its search path has to gain the workspace directory or the visible
        # suite beside it becomes unimportable.
        twin = os.path.join(_ROOT, os.path.dirname(rel))
        if os.path.basename(rel) == "__init__.py" and os.path.isdir(twin):
            module.__path__.append(twin)
    shutil.rmtree(root, ignore_errors=True)
    return modules

'''

# The unittest harness: what runs when `harness` is absent or "unittest". It is
# the harness the sealed artefacts run under (phase.json's `hiddenHarness`
# defaults to it for Python), because its seal is the one three tests prove.
UNITTEST_HARNESS = r'''
import json
import time
import unittest


class JsonResult(unittest.TestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.cases = []
        self._case_started = None
        self._case_mark = 0

    def startTest(self, test):
        super().startTest(test)
        self._case_started = time.monotonic()
        self._case_mark = len(self.cases)

    def stopTest(self, test):
        # Stamp every row this test produced (a failure plus a tearDown error
        # is two) so a slow case is visible next to a fast one.
        started = self._case_started if self._case_started is not None else time.monotonic()
        elapsed = int((time.monotonic() - started) * 1000)
        for case in self.cases[self._case_mark:]:
            case["durationMs"] = elapsed
        super().stopTest(test)

    @staticmethod
    def _name(test):
        ident = test.id()
        parts = ident.split(".")
        return ".".join(parts[-2:]) if len(parts) >= 2 else ident

    def addSuccess(self, test):
        super().addSuccess(test)
        self.cases.append({"name": self._name(test), "status": "passed"})

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.cases.append({"name": self._name(test), "status": "failed", **self._format_err(err)})

    def addError(self, test, err):
        super().addError(test, err)
        self.cases.append({"name": self._name(test), "status": "errored", **self._format_err(err)})

    def _format_err(self, err):
        """The one-line message, plus the traceback as frames.

        The message says what broke; it cannot say where. The frames carry
        file, line and the source line itself so the report can point at the
        failure without making the learner read a raw traceback.
        """
        exc_type, exc_value, tb = err
        text = "".join(str(part) for part in [exc_type.__name__, ": ", exc_value])
        detail = {"message": text.replace(_ROOT + os.sep, "")[:500]}
        frames = _workspace_frames(tb)
        if frames:
            detail["frames"] = frames
        return detail


def main():
    spec = json.loads(sys.argv[1])
    graded_tests = set(spec.get("gradedTestPaths") or [])
    # python -I implies -E, so PYTHONPATH is ignored on purpose. The pre-baked
    # library directory travels in an ordinary environment variable the runner
    # computes, exactly as the pytest harness reads it: without this line a
    # sealed suite can only import Flask on a machine whose own interpreter
    # happens to have it, which is a laptop and never the class's container.
    pylib = os.environ.get("LSDLC_PYLIB")
    if pylib:
        sys.path.insert(0, pylib)
    # python -I drops the working directory from sys.path, and only
    # loader.discover(top_level_dir=".") ever put it back — which a run whose
    # test files are all graded never calls. Both roots go on by hand, the
    # graded one first so a workspace copy cannot shadow what is being graded.
    sys.path.insert(0, _ROOT)
    graded = {}
    if spec.get("gradedDir"):
        sys.path.insert(0, spec["gradedDir"])
        graded = _seal_graded(spec["gradedDir"])
    loader = unittest.defaultTestLoader
    suite = unittest.TestSuite()
    for rel in spec["testPaths"]:
        if rel in graded_tests:
            # Imported and unlinked already: the module is the only copy left.
            suite.addTests(loader.loadTestsFromModule(graded[os.path.normpath(rel)]))
            continue
        directory = "." if "/" not in rel else rel.rsplit("/", 1)[0]
        pattern = rel.rsplit("/", 1)[-1]
        suite.addTests(loader.discover(directory, pattern=pattern, top_level_dir="."))
    result = JsonResult()
    suite.run(result)
    passed = sum(1 for c in result.cases if c["status"] == "passed")
    failed = sum(1 for c in result.cases if c["status"] == "failed")
    errored = sum(1 for c in result.cases if c["status"] == "errored")
    payload = {
        "total": len(result.cases),
        "passed": passed,
        "failed": failed,
        "errored": errored,
        "cases": result.cases,
    }
    print("@@LSDLC_RESULT@@" + json.dumps(payload))


if __name__ == "__main__":
    main()
'''

BOOTSTRAP = BLOCKS + SEAL + UNITTEST_HARNESS


# The pytest harness: what runs when a phase asks for `harness: "pytest"`.
#
# It is the harness the learner reads and writes (plain `assert`, fixtures,
# parametrize), and it gets the same blocklist and the same seal as the unittest
# one, by construction rather than by review, because both are the strings
# above. Only the tail differs: pytest is imported after the seal, from the
# pre-baked library directory, and one plugin turns its reports into the same
# `cases` rows the unittest harness produces.
PYTEST_HARNESS = r'''
import json
import time


def _pytest_message(excinfo, collecting=False):
    """"TypeError: unsupported operand" — the same sentence shape both harnesses
    produce, so a learner reading the Tests pane cannot tell which one ran.

    A rewritten `assert` carries its whole explanation in the exception, and a
    collection error carries a whole traceback: one line each way, because the
    frames below already say where, and the report shows one line here. For a
    failed collection the useful line is the last one pytest marked with E —
    "ModuleNotFoundError: No module named 'flask'" — not its own first line
    about importing a test module.
    """
    text = "".join(str(part) for part in [excinfo.type.__name__, ": ", excinfo.value])
    text = text.replace(_ROOT + os.sep, "")
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) > 1:
        marked = [line for line in lines if line.startswith("E ")]
        text = (marked[-1][1:] if (collecting and marked) else lines[0]).strip()
    return text[:500]


class _Collector:
    """pytest's reports, as the rows the graders already read.

    Two hooks, because one report does not carry enough. `logreport` says what
    happened and how long it took; `exception_interact` is the only place the
    real exception object is available, and telling AssertionError from anything
    else is the whole distinction between "your test failed" and "your test blew
    up" — the one the kill matrix and scoreTests are built on.

    The rows are built at the end rather than as they arrive, because pytest
    fires the two hooks in opposite orders for tests and for collection: a test
    is logged and then interacted with, a collector is interacted with and then
    logged. Join by report identity: pytest 9 subtests share their parent's
    nodeid and phase but carry different exceptions and tracebacks.
    """

    def __init__(self, subtest_report_type=()):
        self.cases = []
        self._rows = []
        self._detail = {}
        self._subtest_report_type = subtest_report_type
        self._subtest_counts = {}
        self._call_outcomes = {}

    def pytest_runtest_makereport(self, item, call):
        # Registered as the outermost wrapper after the sealed pytest import.
        # This sees the completed outcome (including strict XPASS) before
        # subtests' terminal-report hook turns a passed parent into an aggregate.
        report = yield
        if call.when == "call":
            self._call_outcomes[id(report)] = (report, report.passed, report.failed)
        return report

    def pytest_exception_interact(self, node, call, report):
        excinfo = getattr(call, "excinfo", None)
        detail = {"exception": excinfo is not None, "assertion": False, "message": "", "frames": []}
        if excinfo is not None:
            detail["assertion"] = isinstance(excinfo.value, AssertionError)
            detail["message"] = _pytest_message(excinfo, getattr(call, "when", "") == "collect")
            try:
                detail["frames"] = _workspace_frames(excinfo.tb)
            except Exception:
                detail["frames"] = []
        # Retain the report too, so Python cannot reuse its id before finish.
        self._detail[id(report)] = (report, detail)

    def pytest_runtest_logreport(self, report):
        subtest = isinstance(report, self._subtest_report_type)
        name = report.nodeid.split("::", 1)[-1]
        if subtest:
            number = self._subtest_counts.get(report.nodeid, 0) + 1
            self._subtest_counts[report.nodeid] = number
            description = report._sub_test_description()[:160]
            name = f"{name} [subtest {number}: {description}]"
        # A skip records nothing, exactly as unittest's JsonResult records
        # nothing for addSkip: a skipped case is not a result either way.
        if report.skipped:
            return
        if report.when == "call":
            self._rows.append((name, report, "call", report.passed, report.duration, subtest))
        elif report.failed:
            # A fixture or a teardown blew up: no call phase ever ran, and a
            # suite that reported nothing here would report zero failures.
            self._rows.append((name, report, report.when, False, report.duration, subtest))

    def pytest_collectreport(self, report):
        # A file that will not import produces no runtest report at all. One
        # errored case named after the file, exactly as the JS harness does in
        # its catch — otherwise a broken suite reports zero failures and passes.
        if report.failed:
            self._rows.append((report.nodeid or "collection", report, "collect", False, 0, False))

    def finish(self):
        """Join the rows to their details. Called once, after pytest.main."""
        for name, report, when, passed, duration, subtest in self._rows:
            detail = self._detail.get(id(report), (None, {}))[1]
            _, initially_passed, initially_failed = self._call_outcomes.get(id(report), (None, False, False))
            # pytest changes the parent outcome to failed when a subtest fails.
            # Its aggregate is not another test; its own exception, if any, is.
            if (when == "call" and not subtest and initially_passed and report.nodeid in self._subtest_counts
                    and not detail.get("exception")):
                continue
            if passed:
                status = "passed"
            elif when == "call" and detail.get("assertion"):
                status = "failed"
            elif when == "call" and initially_failed and not detail.get("exception"):
                # Strict XPASS and other pytest-generated call failures have
                # no exception object, but are independent failed evidence.
                status = "failed"
                detail = {**detail, "message": str(report.longrepr)[:500]}
            else:
                # A setup or teardown that blows up is an error whatever raised
                # it, and so is a file that will not import.
                status = "errored"
            case = {"name": name, "status": status}
            if status != "passed":
                if detail.get("message"):
                    case["message"] = detail["message"]
                if detail.get("frames"):
                    case["frames"] = detail["frames"]
            case["durationMs"] = int((duration or 0) * 1000)
            self.cases.append(case)
        return self.cases


def main():
    spec = json.loads(sys.argv[1])
    # python -I implies -E, so PYTHONPATH is ignored on purpose. The pre-baked
    # library directory travels in an ordinary environment variable the runner
    # computes, and this is the one line that reads it.
    pylib = os.environ.get("LSDLC_PYLIB")
    if pylib:
        sys.path.insert(0, pylib)
    sys.path.insert(0, _ROOT)
    if spec.get("gradedDir"):
        sys.path.insert(0, spec["gradedDir"])
        _seal_graded(spec["gradedDir"])

    # After the seal, so the graded artefacts are imported and unlinked before
    # a single line of pytest — let alone of the learner's suite — has loaded.
    import pytest
    try:
        from _pytest.subtests import SubtestReport
    except ImportError:
        SubtestReport = ()  # pytest before 9 has no built-in subtest reports.

    pytest.hookimpl(wrapper=True, tryfirst=True)(_Collector.pytest_runtest_makereport)
    collector = _Collector(SubtestReport)
    code = pytest.main(
        [
            "-q",
            # Not optional: pytest writes .pytest_cache, and RLIMIT_FSIZE and a
            # read-only runner image both make that write a failure.
            "-p", "no:cacheprovider",
            "--tb=short",
            # One file that will not import is one errored case, not a run that
            # stops: the unittest and JS harnesses both report the rest of the
            # suite, and a learner comparing two layers must see the same rule.
            "--continue-on-collection-errors",
            "--import-mode=importlib",
            "--rootdir", _ROOT,
            *spec["testPaths"],
        ],
        plugins=[collector],
    )
    collector.finish()
    if not collector.cases and code not in (0, 1, 5):
        collector.cases.append({
            "name": ", ".join(spec["testPaths"]) or "pytest",
            "status": "errored",
            "message": "pytest could not run this suite (exit code %d)." % code,
            "durationMs": 0,
        })

    cases = collector.cases
    counted = lambda status: sum(1 for case in cases if case["status"] == status)
    print("@@LSDLC_RESULT@@" + json.dumps({
        "total": len(cases),
        "passed": counted("passed"),
        "failed": counted("failed"),
        "errored": counted("errored"),
        "cases": cases,
    }))


if __name__ == "__main__":
    main()
'''

PYTEST_BOOTSTRAP = BLOCKS + SEAL + PYTEST_HARNESS


# Which limit killed a child that never printed a result line. Negative codes
# are signals: SIGXCPU is the CPU rlimit, SIGKILL is RLIMIT_AS or the cgroup
# OOM killer. Anything else is a harness or load error, not a resource one.
EXIT_KIND_BY_SIGNAL = {
    -signal.SIGXCPU: "timeout",
    -signal.SIGKILL: "memory",
}


def make_preexec(memory_mb, cpu_seconds, limit_address_space=True, nofile=128, ruleset_fd=None):
    # Sampled in the parent: the closure runs post-fork, where scanning /proc
    # would race the very children the limit is meant to bound.
    nproc = uid_task_count() + NPROC_HEADROOM if NPROC_HEADROOM > 0 else None

    def preexec():
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        if nproc is not None:
            try:
                resource.setrlimit(resource.RLIMIT_NPROC, (nproc, nproc))
            except (ValueError, OSError):
                pass  # hard limit already lower than the headroom: keep it
        # RLIMIT_AS caps VIRTUAL memory, which suits CPython but kills V8: Node
        # reserves multi-GB of virtual address space for its code range at
        # startup even though resident use stays small. For JS the heap is
        # capped with --max-old-space-size instead, so skip the AS rlimit here.
        if limit_address_space:
            limit = memory_mb * 1024 * 1024
            try:
                resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
            except (ValueError, OSError):
                # macOS rejects RLIMIT_AS with EINVAL, which Python surfaces as
                # ValueError. No learner run reaches this on macOS, because the
                # isolation gate refuses every job there; the unit tests that
                # stand in for the gate do, and the CPU, file size and
                # descriptor caps still apply to them, so they keep going.
                pass
        resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
        # 128 is right for a test run, which opens its own files and nothing
        # else. A long-lived child that serves requests needs more, so the cap
        # is a parameter rather than a constant; it is still a cap.
        resource.setrlimit(resource.RLIMIT_NOFILE, (nofile, nofile))
        try:
            os.setsid()
        except OSError:
            pass  # already a session leader (some container runtimes)
        if ruleset_fd is not None:
            # Last, and fatal if it fails: a child that could not be fenced
            # does not run. The parent sees SubprocessError, not a result.
            landlock_enforce(ruleset_fd)

    return preexec


def reap_group(pid, group_id=None):
    """Terminate a child's whole process group, fork-bomb-proof.

    A bare SIGKILL races a forking child: the group refills in the kill window.
    The classic mitigation is to SIGSTOP the group first (an uncatchable freeze
    that halts all forking), then SIGKILL, looping to convergence so any process
    that slipped in before the freeze is caught next sweep. Root ignores
    RLIMIT_NPROC, so this (not a proc cap) is what contains a runaway locally;
    in production each run is an isolated Lambda with cgroup pid limits, torn
    down wholesale after every invoke.

    A module function rather than a closure because the preview supervisor stops
    its long-lived child the same way, and one implementation of "kill the whole
    group" is the only version of this that stays correct.
    """
    if group_id is None:
        try:
            pgid = os.getpgid(pid)
        except ProcessLookupError:
            return
    else:
        # Preview spawn records its setsid group. Descendants can outlive the
        # leader, so looking up an already-exited leader would skip teardown.
        pgid = group_id
    for _ in range(50):
        try:
            os.killpg(pgid, signal.SIGSTOP)
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            return
        except PermissionError:
            # macOS answers EPERM, not ESRCH, once the only members left are
            # zombies whose exit status nobody has collected yet. Every process
            # in this group descends from our own child and shares our uid, so
            # EPERM here cannot mean "a live process we are not allowed to
            # signal": it means there is nothing left alive to signal. Without
            # this the second sweep would raise out of run_child on macOS, where
            # the unit tests that stand in for the isolation gate run children,
            # and a timed-out run would come back as an exception rather than as
            # a timeout.
            return
        time.sleep(0.05)


# Environment the runner computes for itself. A job may not set any of these:
# they name paths on the host, and a job that could choose them would choose the
# library a learner's code imports. TASKTRACKR_DB is deliberately not here: a
# pack's preview block names its own database file, and that file is inside the
# workspace either way.
RUNNER_OWNED_ENV = frozenset({
    "PATH", "PYTHONDONTWRITEBYTECODE", "PYTHONHASHSEED", "HOME",
    "TASKTRACKR_DATA", "LSDLC_PYLIB", "NODE_PATH", "ESBUILD_BIN", "PYTHONPATH",
    # The fence: where the child's temp files go, and which directories beyond
    # its workspace the in-process file policy lets it reach. A job that could
    # set either would name a sibling's workspace.
    "TMPDIR", "LSDLC_FS_ROOTS", ISOLATION_ENV,
})

#: The runner-owned variable that carries a run's extra roots (the sealed
#: graded directory) to the file policy inside the bootstraps.
FS_ROOTS_ENV = "LSDLC_FS_ROOTS"

#: The PATH every process this runner starts gets: the system directories and
#: nothing from the runner's own environment.
CHILD_PATH = "/usr/local/bin:/usr/bin:/bin"


def child_env(workspace, extra_env=None, extra_roots=None):
    """The complete environment a sandboxed child gets.

    This dict is an allowlist, not a starting point: the runner inherits the
    API's environment in RUNNER_MODE=local (JWT_SECRET, DATABASE_URL), so
    anything that reaches the child has to be put here deliberately. `extra_env`
    is the one seam, and its callers pass values they have validated first (a
    date matching CLOCK_PATTERN, a port the kernel gave us). A general
    pass-through of job-supplied environment would be a real vulnerability,
    which is why the runner-owned keys above are refused outright rather than
    quietly overwritten.

    TASKTRACKR_DATA and TASKTRACKR_DB are the content contract's names for a
    run's data file and database. A pack's programs read them under these
    names whichever pack is running, so they are set for every run.
    """
    env = {
        "PATH": CHILD_PATH,
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHASHSEED": "0",
        "HOME": workspace,
        "TASKTRACKR_DATA": os.path.join(workspace, "tasks.json"),
        # A sqlite file inside the workspace, so the canonical application's
        # default database is thrown away with the run that made it.
        "TASKTRACKR_DB": os.path.join(workspace, "tasktrackr.db"),
        # Inside the workspace, because /tmp is on the far side of the fence.
        "TMPDIR": os.path.join(workspace, CHILD_TMPDIR_NAME),
    }
    if extra_roots:
        env[FS_ROOTS_ENV] = os.pathsep.join(extra_roots)
    # The pre-baked layer, computed here and never taken from a job. python -I
    # implies -E, so PYTHONPATH would be ignored anyway: the harness reads
    # LSDLC_PYLIB and puts it on sys.path itself.
    pylib = runtime_site_packages()
    if pylib:
        env["LSDLC_PYLIB"] = pylib
        # PYTHONPATH as well, for the children that are NOT run in isolated
        # mode: the pack's own program under mode=smoke, which builds its Flask
        # app to count its routes, and the learner's app under the preview
        # supervisor. python -I implies -E, so every test child ignores this and
        # reads LSDLC_PYLIB from inside its harness instead.
        env["PYTHONPATH"] = pylib
    node_modules = runtime_node_modules()
    if node_modules:
        env["NODE_PATH"] = node_modules
    esbuild = runtime_esbuild()
    if esbuild:
        env["ESBUILD_BIN"] = esbuild
    if extra_env:
        for key in extra_env:
            if key in RUNNER_OWNED_ENV:
                raise ValueError(f"{key} is set by the runner and cannot be passed in a job")
        env.update(extra_env)
    return env


def spawn_child(argv, workspace, memory_mb, cpu_seconds, extra_env=None, nofile=128,
                limit_address_space=True, extra_roots=None):
    """Start one sandboxed child and hand back the Popen, still running.

    Popen (not subprocess.run) so a caller can kill the child's entire process
    GROUP, not just the child PID. The preexec calls os.setsid(), so the child
    leads a new group; killing the group reaps fork-bombed descendants that
    would otherwise survive a bare child SIGKILL and pile up as orphans.

    Split out of run_child so that a child which outlives one request (the
    learner's own app, under the preview supervisor) is started with exactly
    the same limits, the same environment allowlist and the same setsid as a
    graded test run. There is one spawn in this file, and this is it.

    `extra_roots` are the directories beyond the workspace this one child may
    reach: a graded run's sealed directory, which its harness imports and
    deletes before any learner code loads. Both layers of the fence read them.
    """
    extra_roots = list(extra_roots or ())
    # The child's temp directory, created before the fence is built so the
    # fence sees it exist. A missing one is not a run: every rule below hangs
    # off the workspace, and Popen would fail on the cwd just the same.
    os.makedirs(os.path.join(workspace, CHILD_TMPDIR_NAME), exist_ok=True)
    fence = landlock_ruleset(workspace, extra_roots, programs=(argv[0],))
    try:
        return subprocess.Popen(
            argv,
            cwd=workspace,
            env=child_env(workspace, extra_env, extra_roots),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            preexec_fn=make_preexec(
                memory_mb, cpu_seconds, limit_address_space, nofile, ruleset_fd=fence,
            ),
        )
    finally:
        if fence is not None:
            os.close(fence)


def run_child(argv, workspace, timeout_seconds, memory_mb, limit_address_space=True,
              extra_env=None, nofile=128, extra_roots=None):
    """Run one child to completion. (returncode, stdout, stderr, exit kind)."""
    proc = spawn_child(
        argv, workspace, memory_mb, timeout_seconds,
        extra_env=extra_env, nofile=nofile, limit_address_space=limit_address_space,
        extra_roots=extra_roots,
    )
    sampler = ChildSampler(proc.pid)
    try:
        stdout, stderr = proc.communicate(timeout=timeout_seconds)
        return proc.returncode, stdout, stderr, "ok"
    except subprocess.TimeoutExpired as expired:
        stage("timeout")
        sampler.sample()  # Snapshot the exact child before SIGKILL removes /proc.
        reap_group(proc.pid)
        try:
            stdout, stderr = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired as cleanup_expired:
            # communicate() retains its buffers between calls, so the later
            # exception contains cumulative output, not a chunk to append.
            # Recover each stream independently if cleanup supplied no data.
            stdout = timeout_output_text(cleanup_expired.output or expired.output)
            stderr = timeout_output_text(cleanup_expired.stderr or expired.stderr)
        return -1, stdout or "", stderr or "", "timeout"
    finally:
        sampler.close()


def timeout_output_text(output, limit=20000):
    """Bound a partial timeout snapshot before decoding possibly split bytes.

    TimeoutExpired can carry bytes even for text-mode Popen. A killed child
    may leave an incomplete UTF-8 sequence; losing the entire diagnostic to a
    decoding error is worse than replacing that one sequence. Successful
    communicate() output keeps its existing handling and is not clipped here.
    """
    if output is None:
        return ""
    truncated = len(output) > limit
    text = output[:limit]
    if isinstance(text, bytes):
        text = text.decode("utf-8", errors="replace")
    return text + ("\n… (truncated)" if truncated else "")


def clip(text, limit=20000):
    text = text or ""
    return text if len(text) <= limit else text[:limit] + "\n… (truncated)"


def parse_result_line(stdout):
    """The harness's result object, or None if it never emitted a usable one.

    A missing or malformed line means the harness died mid-run. Returning None
    (rather than raising, which the transport swallows into a generic error)
    lets execute_job report exitKind "error" with tests null, which the report
    can tell apart from a suite that ran and failed.
    """
    found = None
    for line in stdout.splitlines():
        if not line.startswith(RESULT_MARKER):
            continue
        try:
            payload = json.loads(line[len(RESULT_MARKER):])
        except ValueError:
            continue
        counts = ("total", "passed", "failed", "errored")
        if (
            isinstance(payload, dict)
            and all(isinstance(payload.get(key), int) for key in counts)
            and isinstance(payload.get("cases"), list)
        ):
            found = payload
    return found


def interpreter_names():
    """The absolute host paths a message may name, and what to say instead.

    A failed run prints the interpreter that failed, and that path is the
    host's, not the learner's container: on a developer machine it is an
    anaconda directory under someone's home, and on the deployment it is the
    image's /usr/local/bin. Neither is a place the learner has, so the command
    word is the honest form of the same sentence.

    The pre-baked dependency layer goes the same way and for the same reason. A
    pytest collection error inside flask, or a React stack through the baked
    react-dom, otherwise prints the absolute path of a directory that is ours
    and not the learner's, and one that differs on every machine, so the same
    failure reads differently on a laptop and in the container. `sandbox` is
    what it is: a library the sandbox brought, not a file the learner wrote.
    The order is the order they are applied in, so the esbuild binary is named
    BEFORE the tree it sits inside: otherwise "esbuild: permission denied"
    would come back as "sandbox/bin/esbuild: permission denied", which is a
    path the learner still cannot use.
    """
    pairs = [(sys.executable, "python3")]
    node = _node_bin()
    if os.sep in node:
        pairs.append((node, "node"))
    esbuild = runtime_esbuild()
    if esbuild:
        pairs.append((esbuild, "esbuild"))
    pairs.append((runtime_root(), "sandbox"))
    return [(path, word) for path, word in pairs if path and os.sep in path]


def redact_workspace(value, roots):
    """Strip host paths out of everything we return.

    The frames are already workspace-relative; this catches the rest (a
    traceback in stderr, a "cannot find module" message), including the
    unresolved mkdtemp path, which differs from the child's cwd wherever /var
    is a symlink. The path names a temp directory that is deleted seconds
    later, so it is noise to the learner and host detail to everyone else. The
    interpreter path goes the same way, for the same two reasons.
    """
    if isinstance(value, str):
        for root in roots:
            value = value.replace(root + os.sep, "").replace(root, ".")
        for path, word in interpreter_names():
            value = value.replace(path, word)
        return value
    if isinstance(value, list):
        return [redact_workspace(item, roots) for item in value]
    if isinstance(value, dict):
        return {key: redact_workspace(item, roots) for key, item in value.items()}
    return value


def safe_join(root, rel):
    """root/rel, refusing any path that would leave root. The one path rule.

    Written once and used twice: `write_job_files` decides where a job's files
    land, and the preview's `/app/asset` decides which file a browser is
    allowed to ask for. Two copies of "does this escape?" is how one of them
    ends up serving /etc/passwd.
    """
    if not isinstance(rel, str):
        raise ValueError(f"illegal path: {rel!r}")
    normalised = os.path.normpath(rel)
    if os.path.isabs(normalised) or normalised == ".." or normalised.startswith(".." + os.sep):
        raise ValueError(f"illegal path: {rel}")
    return os.path.join(root, normalised)


def write_job_files(root, files):
    """Write a job's files under root, refusing any path that would escape it."""
    for rel, content in files.items():
        try:
            dest = safe_join(root, rel)
        except ValueError:
            raise ValueError(f"illegal path in job: {rel}")
        os.makedirs(os.path.dirname(dest) or root, exist_ok=True)
        with open(dest, "w", encoding="utf-8") as fh:
            fh.write(content)


#: esbuild is given 20 seconds of its own. It is the platform's binary, not the
#: learner's code, and it compiles the whole workspace in tens of milliseconds:
#: anything near this bound is a broken install, not a slow project.
TRANSFORM_TIMEOUT_SECONDS = 20

#: The languages whose child is node.
JS_LANGUAGES = ("javascript", "typescript")


def limits_address_space(language):
    """Whether a child running this language gets an RLIMIT_AS.

    Only CPython does. V8 reserves multi-gigabyte virtual ranges at startup
    while its resident use stays small, so an address-space rlimit kills node
    before it runs a line; --max-old-space-size is the cap that fits it, and
    every node child is started with one. TypeScript is node by the time the
    child sees it, so it answers the same as JavaScript, and this is a
    function rather than a comparison written out at each call site because
    getting it wrong for one language would look like "the runner died".
    """
    return language == "python"

# One esbuild diagnostic, as it is printed with --color=false:
#
#     ✘ [ERROR] Expected ">" but found ";"
#
#         web/src/lib/overdue.ts:3:22:
#           3 │   return due <<< today;
#
# The glyph is matched by its tag rather than by ✘ so a child that hands back
# bytes in some other encoding still parses. The location line is the FIRST one
# after the tag; a diagnostic may carry a second ("the opening tag is here"),
# which belongs to the same error and is not a case of its own.
ESBUILD_ERROR = re.compile(r"\[ERROR\]\s+(.*?)\s*$")
ESBUILD_LOCATION = re.compile(r"^\s{4}(\S.*?):(\d+):(\d+):\s*$")


def source_line(path, line):
    """One line of a workspace file, trimmed the way the harnesses trim theirs."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for number, text in enumerate(fh, start=1):
                if number == line:
                    return text.strip()[:160]
    except OSError:
        pass
    return ""


def esbuild_cases(diagnostics, workspace):
    """One errored case per esbuild diagnostic.

    A TypeScript file that does not compile has to arrive in the Tests pane as a
    red row that clicks through to the line, not as raw stderr under a run that
    reads "0 tests passed". The run is also exitKind "error"; the two say
    different things and the learner needs both: nothing ran, and here is why.
    """
    cases = []

    def add(message, path, line):
        case = {"name": path or "esbuild", "status": "errored", "message": message,
                "durationMs": 0}
        if path and line:
            frame = {"path": path, "line": line}
            snippet = source_line(os.path.join(workspace, path), line)
            if snippet:
                frame["snippet"] = snippet
            case["frames"] = [frame]
        return cases.append(case)

    message = None
    for text in (diagnostics or "").splitlines():
        found = ESBUILD_ERROR.search(text)
        if found:
            if message is not None:
                add(message, None, None)  # the previous error printed no location
            message = found.group(1)
            continue
        if message is None:
            continue
        where = ESBUILD_LOCATION.match(text)
        if where:
            add(message, where.group(1), int(where.group(2)))
            message = None
    if message is not None:
        add(message, None, None)
    return cases


def transform_typescript(workspace):
    """Compile the workspace's TypeScript to CommonJS, in place, in the parent.

    Per file and never bundled, so the module graph the learner wrote survives
    into require() and a stack frame still names web/src/components/TaskRow.tsx
    rather than one bundle. The .ts source stays where it is beside the .js:
    the inline source map points back at it, node is started with
    --enable-source-maps, and the harness reads the snippet off the original.

    In the parent because the child cannot spawn (JS_HARNESS blocks every
    child_process entry point and BOOTSTRAP blocks every exec), and esbuild is a
    native binary, not a library. It is our binary, checksummed at pre-bake time
    and named by us, so nothing here is taken from the job.

    Types are not checked: esbuild strips them, and tsc --noEmit would cost two
    to four seconds on every run of the fast loop.

    Returns esbuild's diagnostics when the compile failed, and None when it
    succeeded or when the workspace holds no TypeScript at all.
    """
    sources = []
    for dirpath, dirnames, filenames in os.walk(workspace):
        # A dependency directory is not the learner's code, and compiling one
        # would be minutes of work for a result nothing imports.
        dirnames[:] = [name for name in dirnames if name != "node_modules"]
        for name in filenames:
            if name.endswith((".ts", ".tsx")):
                sources.append(os.path.relpath(os.path.join(dirpath, name), workspace))
    if not sources:
        return None
    esbuild = runtime_esbuild()
    if esbuild is None:
        return PREBAKE_MISSING_MESSAGE
    argv = [
        esbuild, "--color=false", *sorted(sources),
        # Relative paths, run from the workspace, so every diagnostic esbuild
        # prints is already workspace-relative and no redaction has to catch it.
        "--outdir=.", "--outbase=.",
        "--format=cjs", "--platform=node", "--target=node20", "--jsx=automatic",
        "--sourcemap=inline", "--log-level=warning",
    ]
    proc = fenced_run(
        argv,
        workspace,
        programs=(esbuild,),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        # Its own environment, not ours: this runs in the parent, which in
        # RUNNER_MODE=local is the API process and holds the API's secrets.
        env={"PATH": CHILD_PATH, "HOME": workspace},
        timeout=TRANSFORM_TIMEOUT_SECONDS,
    )
    return proc.stderr if proc.returncode else None


# The run clock: an ISO date, and nothing else. Validated here as well as in the
# API because the runner is the trust boundary: the API is one caller of this
# contract, and a value that reaches a child's environment has to be checked
# where it is used, not only where it was written.
CLOCK_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def clock_env(job):
    """{"LEARNSDLC_NOW": date} when the job pins the clock, else {}.

    A malformed clock is dropped rather than raised: the job is still a valid
    request to run the learner's code, and refusing the whole run over a
    parameter the learner's code cannot even see would turn a typo somewhere
    upstream into an outage. Dropping it means the child sees the machine's
    date, which is what an unpinned clock means.
    """
    clock = job.get("clock")
    if not isinstance(clock, str) or not CLOCK_PATTERN.match(clock):
        return {}
    return {"LEARNSDLC_NOW": clock}


#: Which harness runs a language when the job does not say: a Python job with
#: no `harness` runs under unittest, a JavaScript or TypeScript one under the
#: JS harness.
DEFAULT_HARNESS = {"python": "unittest", "javascript": "js", "typescript": "js"}

#: What each harness can run. A job that pairs them wrongly is a caller's bug
#: and is refused here, where the contract is, rather than failing as a strange
#: result the learner would have to interpret.
HARNESS_LANGUAGES = {
    "unittest": {"python"},
    "pytest": {"python"},
    # TypeScript is JavaScript by the time the child sees it: the parent
    # compiles it with esbuild first, so one harness runs both and the DOM
    # preamble is the only thing that tells them apart.
    "js": {"javascript", "typescript"},
}


def harness_for(job):
    """The harness this job asks for, validated against its language."""
    language = job.get("language", "python")
    harness = job.get("harness") or DEFAULT_HARNESS.get(language, "js")
    if harness not in HARNESS_LANGUAGES:
        raise ValueError(f"unknown harness: {harness}")
    if language not in HARNESS_LANGUAGES[harness]:
        raise ValueError(f"the {harness} harness cannot run {language}")
    return harness


#: What a JavaScript job comes back with on a transport that has no node. The
#: Lambda package is a python3.11 function (scripts/localstack-lambda.sh says
#: so), and the front-end half of a phase cannot run there at all.
JS_UNAVAILABLE_MESSAGE = (
    "this transport cannot run JavaScript: there is no node here. "
    "The front-end half of a phase needs RUNNER_MODE=local or socket."
)


def js_runtime_missing(node_bin):
    """Whether a JavaScript job has no node to run on, on this transport.

    Only the interpreter is asked about here. A missing pre-baked layer is a
    different fact with its own sentence (`prebake_missing_result`, an error
    that names the command that fixes it), and a laptop that has node but has
    not run the prebake must keep hearing that one.
    """
    if os.sep in node_bin:
        return not os.path.exists(node_bin)
    return shutil.which(node_bin) is None


def transport_cannot_run_js_result():
    """The result a JavaScript job comes back with where there is no node.

    `unavailable`, not `error`: the code never ran, so there is no verdict, and
    `mergeRunResults` turns one unavailable run into an unavailable result with
    the totals dropped. That is the whole point: a learner graded on the
    Python half alone would be scored out of a pack whose pass mark was set
    over both, and a phase that says "you failed the front end" where the front
    end was never executed is the dishonest answer. The transport says what it
    cannot do and nobody is graded on half a pack.
    """
    return {
        "ok": False,
        "exitKind": "unavailable",
        "stdout": "",
        "stderr": JS_UNAVAILABLE_MESSAGE,
        "durationMs": 0,
        "tests": None,
    }


def prebake_missing_result():
    """The result a job comes back with when the pre-baked layer is not here.

    A result rather than a raised error, because the job itself is well formed:
    the machine is not set up, and the sentence says so and names the command
    that fixes it. `ok: False` with `exitKind: "error"` and no tests is the
    shape a report already knows how to render.
    """
    return {
        "ok": False,
        "exitKind": "error",
        "stdout": "",
        "stderr": PREBAKE_MISSING_MESSAGE,
        "durationMs": 0,
        "tests": None,
    }


def execute_job(job):
    diagnostics = Diagnostics()
    token = CURRENT.set(diagnostics)
    try:
        isolation = isolation_status()
        if isolation["status"] != "ok":
            stage("unsupported")
            return {"ok": False, "exitKind": "unavailable", "stdout": "", "stderr": ISOLATION_UNAVAILABLE,
                    "durationMs": 0, "diagnostics": diagnostics.result(), "isolation": isolation}
        stage("prepare")
        answer = _execute_job(job)
        stage("complete")
        answer["diagnostics"] = diagnostics.result()
        answer["isolation"] = isolation
        return answer
    finally:
        CURRENT.reset(token)


def _execute_job(job):
    """Execute one sandbox job and return the result dict.

    This is the single execution contract: the stdin CLI below wraps it for
    the local runner, and lambda_handler.handler wraps it for the AWS Lambda
    runner (exercised against LocalStack in CI).
    """
    files = job.get("files", {})
    graded_files = job.get("gradedFiles") or {}
    mode = job.get("mode", "tests")
    language = job.get("language", "python")
    harness = harness_for(job)
    node_bin = _node_bin()
    timeout_seconds = min(int(job.get("timeoutSeconds", 10)), 60)
    memory_mb = min(int(job.get("memoryMb", 256)), 512)
    extra_env = clock_env(job)
    run_id = job.get("runId")

    if graded_files and mode != "tests":
        # Only the test harnesses know how to import and unlink them; anywhere
        # else they would simply be missing, which is worse than being refused.
        # A preview job is the sharpest case: app mode never seals, so it would
        # be handing a learner's own running app the answer key.
        raise ValueError("gradedFiles is only supported by mode=tests")

    if mode == "preview":
        # A preview is a supervised session, not a job that finishes: it lives
        # in app_session.py behind /app/start, because something has to hold the
        # child while the learner clicks around in it. Naming that here keeps a
        # caller that sends the job to the wrong door from reading it as
        # "unknown mode" and looking for a typo.
        raise ValueError("mode=preview is served by /app/start, not by execute")

    if harness == "pytest" and any(p in graded_files for p in job.get("testPaths", [])):
        # The seal deletes the file before pytest collects anything, and pytest
        # collects from paths rather than from imported modules. A phase that
        # needs a sealed suite says hiddenHarness: "unittest", which is the
        # harness whose seal three tests prove.
        raise ValueError("the pytest harness cannot run a sealed test file; use hiddenHarness unittest")

    if mode == "tests" and harness == "js" and js_runtime_missing(node_bin):
        # Before anything is written to a workspace: a job with nowhere to run
        # is answered, not attempted. Without this the spawn raises
        # FileNotFoundError, the transport turns that into a failed run with no
        # cases, and the grader reads "the front-end suite failed", a sentence
        # about the learner for a fact about the machine.
        return transport_cannot_run_js_result()

    if harness == "pytest" and runtime_site_packages() is None:
        # No pre-baked layer means no pytest, and "ModuleNotFoundError: No
        # module named 'pytest'" would read to a learner as their own bug.
        return prebake_missing_result()

    transform = job.get("transform")
    if transform and transform.get("tool") != "esbuild":
        # Content names a tool the runner knows, never an argv.
        raise ValueError(f"unknown transform tool: {transform.get('tool')}")
    if language == "typescript" and not transform:
        # TypeScript cannot reach node uncompiled, so a run that declares the
        # language and forgets the transform is an authoring slip, not a
        # request to run .tsx through require(). The pack still declares it,
        # and the loader validates the key, but the runner does not need it to do
        # the only possible thing.
        transform = {"tool": "esbuild"}

    if (transform and runtime_esbuild() is None) or (
        language == "typescript" and runtime_node_modules() is None
    ):
        # Same reasoning as pytest above: no esbuild is no compiler and no baked
        # node_modules is no jsdom, and "Cannot find module 'jsdom'" would read
        # to a learner as a fault in the code they just wrote.
        return prebake_missing_result()

    workspace = tempfile.mkdtemp(prefix="lsdlc-")
    # Outside the workspace, and a sibling of it rather than a child, so no
    # relative path the learner's tests can write reaches it.
    graded_dir = tempfile.mkdtemp(prefix="lsdlc-graded-") if graded_files else ""
    # Both forms: the child's cwd is the resolved path, while anything built
    # from `workspace` here (TASKTRACKR_DATA, an argv path) keeps the symlinked
    # one. Longest first so the resolved path is not half-eaten by the other.
    graded_roots = {graded_dir, os.path.realpath(graded_dir)} if graded_dir else set()
    roots = sorted({workspace, os.path.realpath(workspace)} | graded_roots, key=len, reverse=True)
    try:
        write_job_files(workspace, files)
        if graded_dir:
            write_job_files(graded_dir, graded_files)

        # Python test packages need __init__.py for discovery from the root.
        if language == "python":
            for rel in job.get("testPaths", []):
                directory = os.path.dirname(rel)
                if directory:
                    root = graded_dir if rel in graded_files else workspace
                    init = os.path.join(root, directory, "__init__.py")
                    if not os.path.exists(init):
                        open(init, "w").close()

        started = time.monotonic()
        if mode == "tests":
            if transform:
                stage("transform")
                # The graded artefacts are compiled too, and they have to be:
                # the seal maps the workspace path a graded file WOULD have had
                # onto the copy outside the workspace, and node resolves an
                # extensionless import to `.js`. Leave the reference
                # implementation as TypeScript and the seal never matches, so a
                # sealed run would quietly grade the learner's own code against
                # itself and every mutant would survive.
                for root in [workspace] + ([graded_dir] if graded_dir else []):
                    diagnostics = transform_typescript(root)
                    if diagnostics is None:
                        continue
                    # A compile failure is both an errored run and one errored
                    # case per diagnostic: the exit kind is what stops it
                    # reading as "0 tests passed", and the cases are what let
                    # the learner click through to the line.
                    cases = esbuild_cases(diagnostics, root)
                    for case in cases:
                        if run_id:
                            case["step"] = run_id
                    return redact_workspace({
                        "ok": False,
                        "exitKind": "error",
                        "stdout": "",
                        "stderr": clip(diagnostics),
                        "durationMs": int((time.monotonic() - started) * 1000),
                        "tests": {
                            "total": len(cases), "passed": 0, "failed": 0,
                            "errored": len(cases), "cases": cases,
                        },
                    }, roots)
            fetch_stubs = job.get("fetchStubs")
            spec = json.dumps({
                "testPaths": job.get("testPaths", []),
                "gradedDir": graded_dir,
                "gradedTestPaths": [p for p in job.get("testPaths", []) if p in graded_files],
                # The JS harness's share of the budget: it spends a quarter of it
                # on any one case, so a promise that never settles is one errored
                # case rather than a run with no result line at all.
                "timeoutSeconds": timeout_seconds,
                "dom": language == "typescript",
                "fetchStubs": fetch_stubs if isinstance(fetch_stubs, dict) else {},
            })
            if harness == "js":
                harness_path = os.path.join(workspace, "_lsdlc_harness.js")
                with open(harness_path, "w", encoding="utf-8") as fh:
                    fh.write(JS_HARNESS)
                argv = [node_bin, f"--max-old-space-size={memory_mb}"]
                if transform:
                    # The compiled file carries an inline source map; this is
                    # what makes node use it, so a frame names the .tsx the
                    # learner opened and not the .js esbuild wrote beside it.
                    argv.append("--enable-source-maps")
                argv += [harness_path, spec]
            elif harness == "pytest":
                # -S as well as -I: the only Python library directory this child
                # can see is the pre-baked one, so the pytest a learner runs
                # under is the pinned one and no plugin installed on somebody's
                # laptop can join the run. Without it a graded run on a
                # developer machine and the same run in the container are two
                # different runs.
                argv = [sys.executable, "-I", "-S", "-B", "-c", PYTEST_BOOTSTRAP, spec]
            else:
                argv = [sys.executable, "-I", "-B", "-c", BOOTSTRAP, spec]
            stage("test-child")
            code, stdout, stderr, exit_kind = run_child(
                argv,
                workspace,
                timeout_seconds,
                memory_mb,
                limit_address_space=limits_address_space(language),
                extra_env=extra_env,
                # The sealed directory is the one place beyond the workspace
                # this child may reach, and only until its harness deletes it.
                extra_roots=[graded_dir] if graded_dir else None,
            )
            duration_ms = int((time.monotonic() - started) * 1000)
            tests = parse_result_line(stdout)
            if tests and run_id:
                # Which run each case came from. A phase that spans two
                # languages is two jobs, and the API merges their cases into one
                # list; without this stamp the Tests pane could not group them.
                for case in tests["cases"]:
                    case["step"] = run_id
            visible_stdout = "\n".join(
                l for l in stdout.splitlines() if not l.startswith(RESULT_MARKER)
            )
            ok = exit_kind == "ok" and tests is not None and tests["failed"] == 0 and tests["errored"] == 0
            if exit_kind == "ok" and tests is None:
                # No result line: the harness died before it could print one.
                # The signal says which limit did it, and the two are different
                # problems to the learner: SIGXCPU is the CPU rlimit expiring
                # (an infinite loop), SIGKILL is the address-space cap or the
                # cgroup OOM killer (a runaway allocation). Reporting both as
                # "timeout" would send half the learners looking for the wrong bug.
                exit_kind = EXIT_KIND_BY_SIGNAL.get(code, "error")
            result = {
                "ok": ok,
                "exitKind": exit_kind,
                "stdout": clip(visible_stdout),
                "stderr": clip(stderr),
                "durationMs": duration_ms,
                "tests": tests,
            }
        elif mode == "smoke":
            stage("smoke-child")
            outputs = []
            errors = []
            exit_kind = "ok"
            ok = True
            if language in JS_LANGUAGES:
                # syntax-check every .js file the workspace ships
                check_cmds = [
                    [node_bin, "--check", os.path.join(dp, name)]
                    for dp, _dn, fnames in os.walk(workspace)
                    for name in fnames
                    if name.endswith(".js")
                ]
            else:
                check_cmds = [[sys.executable, "-I", "-B", "-m", "compileall", "-q", "."]]
            limit_as = limits_address_space(language)
            for check in check_cmds:
                code, stdout, stderr, kind = run_child(
                    check, workspace, timeout_seconds, memory_mb, limit_address_space=limit_as,
                    extra_env=extra_env
                )
                if kind != "ok" or code != 0:
                    ok = False
                    exit_kind = kind if kind != "ok" else "error"
                    errors.append(stderr or stdout)
                    break
            if ok:
                for argv in job.get("smokeCommands", []):
                    resolved_argv = [
                        sys.executable if a in ("python", "python3") else (node_bin if a == "node" else a)
                        for a in argv
                    ]
                    code, stdout, stderr, kind = run_child(
                        resolved_argv, workspace, timeout_seconds, memory_mb,
                        limit_address_space=limit_as, extra_env=extra_env
                    )
                    outputs.append(stdout)
                    if stderr:
                        errors.append(stderr)
                    if kind != "ok" or code != 0:
                        ok = False
                        exit_kind = kind if kind != "ok" else "error"
                        break
                expect = job.get("expectInOutput")
                if ok and expect and expect not in "\n".join(outputs):
                    ok = False
                    exit_kind = "error"
                    errors.append(f"expected output to contain {expect!r}")
            duration_ms = int((time.monotonic() - started) * 1000)
            result = {
                "ok": ok,
                "exitKind": exit_kind,
                "stdout": clip("\n".join(outputs)),
                "stderr": clip("\n".join(errors)),
                "durationMs": duration_ms,
            }
        else:
            raise ValueError(f"unknown mode: {mode}")

        return redact_workspace(result, roots)
    finally:
        stage("cleanup")
        shutil.rmtree(workspace, ignore_errors=True)
        # The harness deletes this itself, before the learner's code loads; this
        # is the path where the child died before it got that far.
        if graded_dir:
            shutil.rmtree(graded_dir, ignore_errors=True)


def main():
    protect_own_memory()
    print(json.dumps(execute_job(json.load(sys.stdin))))


if __name__ == "__main__":
    main()
