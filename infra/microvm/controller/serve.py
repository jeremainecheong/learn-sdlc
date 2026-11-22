#!/usr/bin/env python3
"""Host-only UNIX HTTP bridge. It never starts learner code on this host."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler

from bridge import Bridge, Config, Refusal, MAX_BODY
from cloud import AwsCli, GuestHttp, GuestError, Unavailable, encode
from registry import Registry
from operation_trace import parse_trace

# Concurrent connections: every finite job holds one for its whole run, so the cap follows the configured
# limits with room for health, previews' status and proxy calls, owner lookups and the operator's reads.
# The cap never falls below CONNECTION_FLOOR, however small the configured limits.
CONNECTION_FLOOR = 12
CONNECTION_HEADROOM = 4


def connection_limit(config):
    return max(CONNECTION_FLOOR, config.job_limit + config.preview_limit + CONNECTION_HEADROOM)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "learnsdlc-microvm-bridge/1"

    def setup(self):
        self.request.settimeout(15)
        super().setup()

    def log_message(self, *args):
        pass  # URL/body/provider details may contain private capabilities.

    def send_json(self, status, payload):
        body = encode(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        if status == 503: self.send_header("Retry-After", "5")
        self.end_headers()
        self.close_connection = True
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, TimeoutError): pass

    def do_GET(self):
        if self.path == "/health": self.send_json(200, self.server.bridge.health())
        else: self.send_json(404, {"error": "unknown runner route"})

    def do_POST(self):
        routes = {"/execute", "/app/start", "/app/status", "/app/stop", "/app/proxy", "/app/asset", "/operation/owner",
                  "/operation/close-expired"}
        if self.path not in routes:
            self.send_json(404, {"error": "unknown runner route"}); return
        try:
            if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
                raise Refusal(400, "one Content-Length is required")
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0: raise Refusal(411, "Content-Length is required")
            if length > MAX_BODY: raise Refusal(413, "job too large")
            raw = self.rfile.read(length)
            if len(raw) != length: raise Refusal(400, "incomplete request")
            def invalid_constant(_): raise ValueError("invalid JSON constant")
            job = json.loads(raw, parse_constant=invalid_constant)
            if not isinstance(job, dict): raise Refusal(400, "job must be an object")
            if len(self.headers.get_all("X-LearnSDLC-Trace", [])) > 1:
                raise Refusal(400, "one platform trace is allowed")
            if self.path == "/execute":
                trace = parse_trace(self.headers.get("X-LearnSDLC-Trace"), "job")
                answer = self.server.bridge.execute(job, **({"trace": trace} if trace else {}))
            elif self.path == "/app/start":
                trace = parse_trace(self.headers.get("X-LearnSDLC-Trace"), "preview")
                answer = self.server.bridge.start(job, **({"trace": trace} if trace else {}))
            elif self.path == "/operation/owner": answer = self.server.bridge.lookup_owner(job)
            elif self.path == "/operation/close-expired": answer = self.server.bridge.close_expired(job)
            else: answer = self.server.bridge.app(self.path.removeprefix("/app/"), job)
            self.send_json(200, answer)
        except Refusal as error:
            self.send_json(error.status, {"error": error.message, "reason": error.message})
        except (ValueError, UnicodeError):
            self.send_json(400, {"error": "invalid JSON request"})
        except GuestError as error:
            self.send_json(error.status, {"error": "remote guest request unavailable",
                                         **failure_diagnostic(error)})
        except (Unavailable, OSError) as error:
            # Infrastructure problems are not fabricated test failures/Passes.
            self.send_json(502, {"error": "remote runner unavailable; saved work is unchanged",
                                 **failure_diagnostic(error)})
        except Exception:
            self.send_json(500, {"error": "remote runner could not complete the request"})


def failure_diagnostic(error):
    """Safe fixed categories for the owner API log, without provider prose."""
    import re
    result = {"diagnosticCode": error.code if isinstance(error, (Unavailable, GuestError)) else "transport_io"}
    operation = getattr(error, "operation_id", None)
    if isinstance(operation, str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", operation):
        result["operationId"] = operation
    stage = getattr(error, "stage", None)
    if stage in {"launch", "readiness", "initial-request", "validate-result", "cleanup"}:
        result["stage"] = stage
    return result


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    # Listen backlog: at least the largest connection cap the bounds allow
    # (JOB_LIMIT_BOUND + PREVIEW_LIMIT_BOUND + CONNECTION_HEADROOM = 48).
    request_queue_size = 64

    def __init__(self, path, bridge):
        self.bridge = bridge
        self.connection_limit = connection_limit(bridge.config)
        self.connections = threading.BoundedSemaphore(self.connection_limit)
        super().__init__(path, Handler)

    def process_request(self, request, address):
        if not self.connections.acquire(blocking=False):
            request.close()
            return
        try: super().process_request(request, address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, address):
        try: super().process_request_thread(request, address)
        finally: self.connections.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", default=os.environ.get("RUNNER_SOCKET", "/run/learnsdlc/runner.sock"))
    parser.add_argument("--registry", default=os.environ.get("MICROVM_REGISTRY", "/var/lib/learnsdlc-microvm/registry.sqlite"))
    parser.add_argument("--aws-bin", default=os.environ.get("MICROVM_AWS_BIN", "/usr/local/bin/aws"))
    args = parser.parse_args()
    os.umask(0o077)
    config = Config.from_env()
    if not Path(args.aws_bin).is_absolute() or not os.access(args.aws_bin, os.X_OK):
        raise ValueError("an absolute executable AWS CLI path is required")
    registry = Registry(args.registry)
    cloud = AwsCli(args.aws_bin, config.region, str(registry.path.parent))
    bridge = Bridge(config, registry, cloud, GuestHttp(cloud, config.region))
    # Registry flock was acquired before touching a stale socket.
    path = Path(args.socket)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not stat.S_ISSOCK(path.stat().st_mode):
            raise ValueError("refusing to replace a non-socket path")
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(1)
            probe.connect(str(path))
        except ConnectionRefusedError:
            path.unlink()
        else:
            raise ValueError("runner socket already serves another process")
        finally:
            probe.close()
    server = Server(str(path), bridge)
    path.chmod(0o660)  # Set group externally to the API container's dedicated socket group.
    stop = threading.Event()

    def reap():
        initial = True
        while not stop.is_set():
            try:
                bridge.sweep(startup=initial)
                initial = False
            except Exception:
                print("MicroVM reconciliation deferred; durable intent retained", file=sys.stderr)
            if stop.wait(5): return

    def shutdown(_signal, _frame):
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    reaper = threading.Thread(target=reap, daemon=True)
    reaper.start()
    print("MicroVM bridge listening on private UNIX socket; cloud readiness is unverified", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        stop.set()
        server.server_close()
        bridge.shutdown()
        path.unlink(missing_ok=True)
        # Daemon threads may still hold registry operations; process exit closes
        # the DB after their durable cleanup intent has been recorded.


def startup_diagnostic(error):
    # Only fixed exception classes and our own basenames are public diagnostics.
    # Never format exception messages, arbitrary filenames, source or locals.
    kind = type(error).__name__
    if kind not in {"ValueError", "KeyError", "OSError", "PermissionError", "FileNotFoundError",
                    "FileExistsError", "BlockingIOError", "OperationalError", "IntegrityError"}:
        kind = "Exception"
    location = "unknown:0"
    trace = error.__traceback__
    while trace is not None:
        basename = Path(trace.tb_frame.f_code.co_filename).name
        if basename in {"serve.py", "bridge.py", "registry.py", "cloud.py"}:
            location = basename + ":" + str(trace.tb_lineno)
        trace = trace.tb_next
    return "MicroVM bridge startup failed; " + kind + " at " + location


def run():
    try:
        main()
        return 0
    except Exception as error:
        print(startup_diagnostic(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
