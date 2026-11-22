"""AWS CLI and HTTPS transports. No credentials, tokens or provider stderr in logs."""
import http.client
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import socket
import tempfile
import time
from urllib.parse import urlsplit

PROTOCOL = "learnsdlc-microvm-v1"
# The one AWS region the preview deployment runs in; Config refuses any other.
PREVIEW_REGION = "ap-southeast-1"
MAX_RESPONSE = 24 * 1024 * 1024


class Unavailable(Exception):
    def __init__(self, message="remote operation unavailable", *, code="unavailable", retryable=False):
        # Only controller-owned codes may reach the registry or diagnostics.
        self.code = code if code in {
            "unavailable", "cloud_timeout", "cloud_response", "cloud_not_found",
            "cloud_access_denied", "cloud_throttled", "cloud_internal", "cloud_quota",
            "cloud_validation", "cloud_conflict", "cloud_auth", "guest_transport",
            "guest_response", "guest_identity", "guest_deadline", "guest_too_large",
            "runtime_not_ready", "operation_cancelled", "invalid_result", "launch_pacing_budget",
        } else "unavailable"
        self.retryable = bool(retryable)
        super().__init__(message)


class CloudError(Unavailable):
    def __init__(self, operation, provider_code, resource_id=None):
        codes = {
            "ResourceNotFoundException": "cloud_not_found",
            "AccessDeniedException": "cloud_access_denied",
            "AccessDenied": "cloud_access_denied",
            "ExpiredTokenException": "cloud_auth",
            "ExpiredToken": "cloud_auth",
            "UnrecognizedClientException": "cloud_auth",
            "ThrottlingException": "cloud_throttled",
            "TooManyRequestsException": "cloud_throttled",
            # The CLI names a bare HTTP status when the answer carries no error code; 429 is a throttle.
            "429": "cloud_throttled",
            "InternalServerException": "cloud_internal",
            "ServiceQuotaExceededException": "cloud_quota",
            "ValidationException": "cloud_validation",
            "ConflictException": "cloud_conflict",
        }
        code = codes.get(provider_code, "unavailable")
        super().__init__("cloud operation unavailable", code=code,
                         retryable=code in {"cloud_throttled", "cloud_internal"})
        self.operation = operation
        # Identity comes from our requested argument, never provider prose.
        self.resource_id = resource_id


def cloud_error(raw, operation, payload):
    """Classify the CLI's fixed error header; discard all provider message text. aws-cli 2.36 writes it as
    "aws: [ERROR]: An error occurred (Code) when calling the Op operation (reached max retries: 0): ...";
    older releases wrote the bare "An error occurred (Code) when calling the Op operation: ..."."""
    names = {"run-microvm": "RunMicrovm", "get-microvm": "GetMicrovm",
             "terminate-microvm": "TerminateMicrovm", "list-microvms": "ListMicrovms",
             "create-microvm-auth-token": "CreateMicrovmAuthToken"}
    match = re.match(rb"\s*(?:aws: \[ERROR\]: )?An error occurred \(([A-Za-z]+|[0-9]{3})\) when calling the "
                     rb"([A-Za-z]+) operation(?: \(reached max retries: [0-9]+\))?:", raw)
    code = "unknown"
    if match and match[2].decode("ascii") == names.get(operation):
        code = match[1].decode("ascii")
    return CloudError(operation, code, payload.get("microvmIdentifier"))


class GuestError(Exception):
    def __init__(self, status, *, authenticated=False):
        self.original_status = status
        self.authenticated = authenticated
        # A signed/bound guest result is final. Only proxy failures can be
        # reconciled by re-reading the same immutable initial operation.
        self.retryable = not authenticated and status in (429, 502, 503, 504)
        self.code = "guest_http_" + str(status) if status in (400, 401, 403, 404, 409, 413, 429, 500, 502, 503, 504) else "guest_http_other"
        self.status = status if status in (400, 404, 409, 413, 429, 503) else 502
        super().__init__("remote guest request did not complete")


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def endpoint_host(endpoint, region):
    if not isinstance(endpoint, str) or len(endpoint) > 2048:
        raise Unavailable("invalid remote endpoint")
    candidate = endpoint if "://" in endpoint else "https://" + endpoint
    url = urlsplit(candidate)
    if (url.scheme != "https" or url.username or url.password or url.port not in (None, 443)
            or url.path not in ("", "/") or url.query or url.fragment
            or not re.fullmatch(r"[a-z0-9-]+\.lambda-microvm\." + re.escape(region) + r"\.on\.aws", url.hostname or "")):
        raise Unavailable("invalid remote endpoint")
    return url.hostname


class AwsCli:
    def __init__(self, binary, region, private_dir):
        self.binary, self.region, self.private_dir = binary, region, private_dir

    def call(self, operation, payload, timeout=20):
        if operation not in {"run-microvm", "get-microvm", "list-microvms",
                             "terminate-microvm", "create-microvm-auth-token"}:
            raise ValueError("unsupported cloud operation")
        # Only the EC2 instance role is available. Never inherit operator keys,
        # profiles, credential_process, endpoint overrides or a web identity.
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
               "AWS_REGION": self.region, "AWS_DEFAULT_REGION": self.region,
               "AWS_CONFIG_FILE": "/dev/null", "AWS_SHARED_CREDENTIALS_FILE": "/dev/null",
               "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS": "true", "AWS_MAX_ATTEMPTS": "1",
               "AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off"}
        with tempfile.TemporaryDirectory(prefix="aws-", dir=self.private_dir) as folder:
            source = Path(folder) / "request.json"
            source.write_bytes(encode(payload))
            source.chmod(0o600)
            with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error_output:
                command = [self.binary, "lambda-microvms", operation, "--region", self.region,
                           "--cli-input-json", "file://" + str(source), "--output", "json",
                           "--no-cli-pager", "--no-paginate", "--cli-connect-timeout", "5",
                           "--cli-read-timeout", str(max(1, int(timeout)))]
                try:
                    process = subprocess.Popen(command, stdout=output, stderr=error_output,
                                               stdin=subprocess.DEVNULL, env=env, start_new_session=True)
                    try:
                        process.wait(timeout=timeout)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                        raise Unavailable("cloud operation timed out", code="cloud_timeout") from None
                    if process.returncode:
                        error_output.seek(0)
                        raise cloud_error(error_output.read(4096), operation, payload)
                    output.seek(0)
                    raw = output.read(1024 * 1024 + 1)
                    if len(raw) > 1024 * 1024:
                        raise Unavailable("cloud response too large")
                    # TerminateMicrovm explicitly returns 200 with no body.
                    # CLI acceptance does not prove teardown: Bridge still
                    # requires the exact VM's terminal state before release.
                    if operation == "terminate-microvm" and not raw.strip():
                        return {}
                    result = json.loads(raw)
                    if not isinstance(result, dict):
                        raise ValueError()
                    return result
                except (OSError, ValueError) as error:
                    raise Unavailable("cloud response unavailable", code="cloud_response") from None

    def launch(self, parameters):
        return self.call("run-microvm", parameters)

    def get(self, vm_id):
        return self.call("get-microvm", {"microvmIdentifier": vm_id}, timeout=10)

    def terminate(self, vm_id):
        return self.call("terminate-microvm", {"microvmIdentifier": vm_id}, timeout=10)

    def token(self, vm_id, timeout=10):
        answer = self.call("create-microvm-auth-token", {
            "microvmIdentifier": vm_id, "expirationInMinutes": 5,
            "allowedPorts": [{"port": 8081}]}, timeout=timeout)
        parts = answer.get("authToken")
        token = parts.get("X-aws-proxy-auth") if isinstance(parts, dict) else None
        if not isinstance(token, str) or not token or len(token) > 8000 or "\n" in token or "\r" in token:
            raise Unavailable("cloud authentication unavailable")
        return token

    def inventory(self, image, version):
        """Bounded diagnostics only. Never adopt/delete unknown VMs by image alone."""
        answer = self.call("list-microvms", {"imageIdentifier": image, "imageVersion": version,
                                            "maxResults": 50}, timeout=10)
        if not isinstance(answer.get("items"), list):
            raise Unavailable("cloud inventory unavailable")
        return answer


class GuestHttp:
    def __init__(self, cloud, region):
        self.cloud, self.region = cloud, region
        self.tokens = {}
        # Duplicate token minting is harmless but avoid it under preview polls.
        import threading
        self.lock = threading.Lock()

    def request(self, row, route, body=None, timeout=30):
        deadline = time.monotonic() + timeout
        host = endpoint_host(row["endpoint"], self.region)
        if not self.lock.acquire(timeout=max(0, deadline - time.monotonic())):
            raise Unavailable("remote request deadline exceeded", code="guest_deadline")
        try:
            cached = self.tokens.get(row["vm_id"])
            if not cached or cached[1] <= time.monotonic():
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise Unavailable("remote request deadline exceeded")
                cached = (self.cloud.token(row["vm_id"], timeout=min(10, remaining)), time.monotonic() + 240)
                self.tokens[row["vm_id"]] = cached
        finally:
            self.lock.release()
        headers = {"X-aws-proxy-auth": cached[0], "X-aws-proxy-port": "8081",
                   "Authorization": "Bearer " + row["control_token"],
                   "X-LearnSDLC-Instance": row["id"], "Content-Type": "application/json"}
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise Unavailable("remote request deadline exceeded")
        connection = http.client.HTTPSConnection(host, timeout=remaining)
        def expire():
            sock = connection.sock
            if sock is not None:
                try: sock.shutdown(socket.SHUT_RDWR)
                except OSError: pass
            connection.close()
        import threading
        timer = threading.Timer(remaining, expire)
        timer.daemon = True
        timer.start()
        try:
            connection.request("GET" if body is None else "POST", route, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise Unavailable("remote response too large")
            try:
                answer = json.loads(raw)
            except (ValueError, UnicodeError):
                if response.status != 200:
                    raise GuestError(response.status) from None
                raise Unavailable("remote response unavailable", code="guest_response") from None
            if not isinstance(answer, dict):
                if response.status != 200:
                    raise GuestError(response.status)
                raise Unavailable("remote response unavailable", code="guest_response")
            expected = {"protocol": PROTOCOL, "instanceId": row["id"],
                        "microvmId": row["vm_id"], "sourceHash": row["source_hash"]}
            bound = all(answer.get(key) == value for key, value in expected.items())
            if not bound and any(key in answer for key in expected):
                raise Unavailable("remote response identity mismatch", code="guest_identity")
            if response.status != 200:
                raise GuestError(response.status, authenticated=bound)
            if not bound:
                raise Unavailable("remote response identity mismatch", code="guest_identity")
            return answer if body is None else answer.get("result")
        except (OSError, http.client.HTTPException):
            raise Unavailable("remote response unavailable", code="guest_transport", retryable=True) from None
        finally:
            timer.cancel()
            connection.close()

    def forget(self, vm_id):
        with self.lock:
            self.tokens.pop(vm_id, None)
