"""Authenticated, immutable adapter from one MicroVM to the existing runner.

The privileged process owns the control token in memory; the existing runner
and every learner subprocess run as uid 65534 with a separate environment.
Each VM accepts exactly one initial job, then serves only that job's preview.
There are no AWS SDKs, platform credentials or generic command/proxy routes.
"""

from __future__ import annotations

import ctypes
import hashlib
import hmac
import http.client
import json
import os
import re
import resource
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROTOCOL = "learnsdlc-microvm-v1"
HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1/"
MAX_BODY = 16 * 1024 * 1024
MAX_RESULT = 32 * 1024 * 1024
HOOK_BODY = 20 * 1024
INITIAL_ROUTES = {"job": "/execute", "preview": "/app/start"}
APP_ROUTES = {"/app/status", "/app/proxy", "/app/asset", "/app/stop"}
HEX_256 = re.compile(r"^[a-f0-9]{64}$")
MICROVM_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,127}$")


class GuestError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(message)


def decode_object(raw: bytes) -> dict:
    def no_duplicates(pairs):
        answer = {}
        for key, value in pairs:
            if key in answer:
                raise ValueError("duplicate JSON key")
            answer[key] = value
        return answer

    def reject_constant(_):
        raise ValueError("non-finite JSON value")

    try:
        value = json.loads(raw, object_pairs_hook=no_duplicates, parse_constant=reject_constant)
        if not isinstance(value, dict):
            raise ValueError("JSON object required")
        return value
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise GuestError(400, "A valid JSON object is required.") from exc


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: int):
        super().__init__("localhost", timeout=timeout)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class RunnerClient:
    def __init__(self, socket_path: str):
        self.socket_path = socket_path

    def request(self, method: str, path: str, raw: bytes = b"") -> tuple[int, dict]:
        conn = UnixConnection(self.socket_path, 180 if path in INITIAL_ROUTES.values() else 30)
        try:
            conn.request(method, path, body=raw or None, headers={"Content-Type": "application/json"})
            response = conn.getresponse()
            if response.getheader("Transfer-Encoding"):
                raise GuestError(502, "The runner returned an unsupported response.")
            length = response.getheader("Content-Length")
            if length is None or not length.isdecimal() or int(length) > MAX_RESULT:
                raise GuestError(502, "The runner response exceeded its limit.")
            data = response.read(int(length) + 1)
            if len(data) != int(length):
                raise GuestError(502, "The runner returned an incomplete response.")
            return response.status, decode_object(data)
        except GuestError:
            raise
        except (OSError, http.client.HTTPException, TimeoutError) as exc:
            raise GuestError(503, "The runner could not complete this request.") from exc
        finally:
            conn.close()


class Guest:
    def __init__(self, runner: RunnerClient):
        self.runner = runner
        self.lock = threading.Lock()
        self.identity: dict | None = None
        self._token: str | None = None
        self.started = False
        self.initial_result: tuple[int, dict] | None = None
        self.app_id: str | None = None
        self.initial_done = threading.Event()

    def bootstrap(self, body: dict) -> dict:
        payload = body.get("runHookPayload")
        microvm_id = body.get("microvmId")
        try:
            payload_bytes = payload.encode("utf-8") if isinstance(payload, str) else b""
        except UnicodeError as exc:
            raise GuestError(400, "The runHookPayload encoding is invalid.") from exc
        if not payload_bytes or len(payload_bytes) > 16 * 1024:
            raise GuestError(400, "A bounded runHookPayload is required.")
        values = decode_object(payload_bytes)
        token, instance_id = values.get("controlToken"), values.get("instanceId")
        source_hash = values.get("sourceHash")
        try:
            valid_instance = isinstance(instance_id, str) and str(uuid.UUID(instance_id)) == instance_id
        except ValueError:
            valid_instance = False
        if (
            values.get("protocol") != PROTOCOL
            or not isinstance(token, str) or not HEX_256.fullmatch(token)
            or not valid_instance
            or not isinstance(source_hash, str) or not HEX_256.fullmatch(source_hash)
            or values.get("purpose") not in INITIAL_ROUTES
            or not isinstance(microvm_id, str) or not MICROVM_ID.fullmatch(microvm_id)
        ):
            raise GuestError(400, "The MicroVM bootstrap contract is invalid.")
        identity = {"protocol": PROTOCOL, "instanceId": instance_id, "microvmId": microvm_id,
                    "sourceHash": source_hash, "purpose": values["purpose"]}
        with self.lock:
            if self.identity is not None:
                if self.identity != identity or not hmac.compare_digest(self._token or "", token):
                    raise GuestError(409, "This MicroVM already belongs to another operation.")
                return {"ok": True}
            # No learner process exists before this binding is established.
            self.identity = identity
            self._token = token
        return {"ok": True}

    def authorize(self, authorization: str | None, instance_id: str | None):
        # Compare bytes so non-ASCII hostile header values cannot raise in hmac.
        supplied = (authorization or "").encode("utf-8")
        expected = ("Bearer " + (self._token or "uninitialized")).encode("ascii")
        if not self.identity or not hmac.compare_digest(supplied, expected):
            raise GuestError(403, "The control request was not authorized.")
        if instance_id != self.identity["instanceId"]:
            raise GuestError(403, "The control request was not authorized.")

    def envelope(self, result: dict) -> dict:
        return {**(self.identity or {}), "result": result}

    def health(self) -> tuple[int, dict]:
        status, result = self.runner.request("GET", "/health")
        if status != 200 or result.get("ok") is not True or result.get("uid") != 65534:
            raise GuestError(503, "The unprivileged runner is not ready.")
        return 200, {**result, **(self.identity or {})}

    def invoke(self, path: str, raw: bytes) -> tuple[int, dict]:
        if not self.identity:
            raise GuestError(403, "The control request was not authorized.")
        job = decode_object(raw)
        initial_path = INITIAL_ROUTES[self.identity["purpose"]]
        if path in INITIAL_ROUTES.values():
            if path != initial_path:
                raise GuestError(409, "The operation does not match this MicroVM's purpose.")
            if not hmac.compare_digest(hashlib.sha256(raw).hexdigest(), self.identity["sourceHash"]):
                raise GuestError(409, "The supplied source does not match this operation.")
            with self.lock:
                own_request = not self.started
                self.started = True
            if not own_request:
                # A disconnected caller may retry, but must never execute twice.
                if not self.initial_done.wait(185):
                    raise GuestError(503, "The initial operation is still running.")
                assert self.initial_result is not None
                return self.initial_result
            try:
                status, result = self.runner.request("POST", path, raw)
                if path == "/app/start" and status == 200:
                    if not isinstance(result.get("id"), str) or not result["id"]:
                        raise GuestError(502, "The runner did not identify its preview.")
                    self.app_id = result["id"]
                answer = (status, self.envelope(result))
            except GuestError as exc:
                # Cache transport failure too: the child may already have run.
                answer = (exc.status, self.envelope({"error": exc.message}))
            except Exception:
                answer = (500, self.envelope({"error": "The operation could not be completed."}))
            self.initial_result = answer
            self.initial_done.set()
            return answer
        if path not in APP_ROUTES:
            raise GuestError(404, "The control route was not found.")
        if self.identity["purpose"] != "preview" or not self.app_id or job.get("id") != self.app_id:
            raise GuestError(404, "The preview was not found.")
        status, result = self.runner.request("POST", path, raw)
        return status, self.envelope(result)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "learnsdlc-microvm/1"
    sys_version = ""

    @property
    def guest(self) -> Guest:
        return self.server.guest

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_):
        # Never log authorization, source, paths, hook payloads or learner output.
        pass

    def send_json(self, status: int, result: dict):
        raw = json.dumps(result, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def read_body(self, maximum: int = MAX_BODY, allow_empty: bool = False) -> bytes:
        lengths = self.headers.get_all("Content-Length") or []
        if not lengths and not self.headers.get("Transfer-Encoding") and allow_empty:
            return b"{}"
        if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not lengths[0].isdecimal():
            raise GuestError(411, "One Content-Length header is required.")
        length = int(lengths[0])
        if length > maximum:
            raise GuestError(413, "The request exceeded its size limit.")
        if length == 0:
            return b"{}"
        try:
            raw = self.rfile.read(length)
        except (OSError, TimeoutError) as exc:
            raise GuestError(408, "The request body did not arrive in time.") from exc
        if len(raw) != length:
            raise GuestError(400, "The request body was incomplete.")
        return raw

    def authorize(self):
        if len(self.headers.get_all("Authorization") or []) != 1:
            raise GuestError(403, "The control request was not authorized.")
        if len(self.headers.get_all("X-LearnSDLC-Instance") or []) != 1:
            raise GuestError(403, "The control request was not authorized.")
        self.guest.authorize(self.headers.get("Authorization"), self.headers.get("X-LearnSDLC-Instance"))

    def do_GET(self):
        try:
            self.authorize()
            if self.path != "/health":
                raise GuestError(404, "The control route was not found.")
            self.send_json(*self.guest.health())
        except GuestError as exc:
            self.send_json(exc.status, {"error": exc.message})

    def do_POST(self):
        authenticated = False
        try:
            if self.path.startswith(HOOK_PREFIX):
                hook = self.path[len(HOOK_PREFIX):]
                if hook not in {"ready", "validate", "run", "resume", "suspend", "terminate"}:
                    raise GuestError(404, "The lifecycle hook was not found.")
                body = decode_object(self.read_body(HOOK_BODY, allow_empty=True))
                if hook == "run":
                    self.send_json(200, self.guest.bootstrap(body))
                elif hook in {"ready", "validate", "resume"}:
                    self.guest.health()
                    self.send_json(200, {"ok": True})
                else:
                    # Lifecycle requests carry no documented authenticated caller
                    # identity. They may not mutate authorization, kill a runner,
                    # execute code or reveal operation IDs/tokens. AWS terminates
                    # the whole VM after its hook independently of this response.
                    self.send_json(200, {"ok": True})
                return
            self.authorize()
            authenticated = True
            if self.path not in set(INITIAL_ROUTES.values()) | APP_ROUTES:
                raise GuestError(404, "The control route was not found.")
            self.send_json(*self.guest.invoke(self.path, self.read_body()))
        except GuestError as exc:
            error = {"error": exc.message}
            self.send_json(exc.status, self.guest.envelope(error) if authenticated else error)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, address, guest: Guest):
        self.guest = guest
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def drop_runner_privileges():
    os.setgroups([])
    os.setgid(65534)
    os.setuid(65534)
    # The uid change clears capabilities; no_new_privs prevents setuid binaries
    # or file capabilities from granting them back to a learner subprocess.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), "could not set no_new_privs")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    resource.setrlimit(resource.RLIMIT_NOFILE, (1024, 1024))
    os.umask(0o077)


def start_runner() -> tuple[subprocess.Popen, RunnerClient]:
    directory = Path("/run/learnsdlc-guest")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    os.chown(directory, 65534, 65534)
    socket_path = str(directory / "runner.sock")
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8",
        "RUNNER_SOCKET": socket_path, "RUNNER_RUNTIME_DIR": "/runner/runtime",
        "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
        "RUNNER_SLOTS": "1", "RUNNER_QUEUE_DEPTH": "1", "RUNNER_MAX_WAIT_MS": "1000",
        # This gateway owns one immutable, at-most-once job in a fresh VM.
        # Never copy this exception from learner JSON or deployment env.
        "RUNNER_ISOLATION": "single-job-microvm",
        "PREVIEW_SESSIONS": "1", "PREVIEW_IDLE_SECONDS": "900",
        "PREVIEW_MAX_SECONDS": "3600", "PREVIEW_MEMORY_MB": "512",
        "SANDBOX_NPROC": "48",
    }
    child = subprocess.Popen(
        ["/usr/local/bin/python3", "/runner/serve.py"], cwd="/runner", env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        preexec_fn=drop_runner_privileges, start_new_session=True, close_fds=True,
    )
    runner = RunnerClient(socket_path)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError("The unprivileged runner exited during startup.")
        try:
            code, health = runner.request("GET", "/health")
            if (code == 200 and health.get("uid") == 65534 and health.get("ok") is True
                    and health.get("isolation") == {"status": "ok", "mechanism": "single-job-microvm"}):
                # Retain the bound fd, but only the root gateway can traverse
                # to the socket. Learner subprocesses cannot call it directly.
                os.chown(directory, 0, 0)
                os.chmod(directory, 0o700)
                return child, runner
        except GuestError:
            pass
        time.sleep(0.1)
    child.terminate()
    raise RuntimeError("The unprivileged runner did not become ready.")


def main():
    if os.getuid() != 0 or sys.platform != "linux":
        raise SystemExit("The MicroVM gateway requires Linux and its privileged supervisor uid.")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
        raise SystemExit("The gateway could not protect its process memory.")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    child, runner = start_runner()
    server = Server(("0.0.0.0", 8081), Guest(runner))

    def stop(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()


if __name__ == "__main__":
    main()
