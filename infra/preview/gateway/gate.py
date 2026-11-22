"""Private preview invitation boundary. No application credentials or request logs."""
import base64
import hashlib
import hmac
import json
import os
import re
import socket
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote

COOKIE = "__Host-learnsdlc-preview"
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43,128}\Z")
HASH_RE = re.compile(r"[a-f0-9]{64}\Z")
CAPABILITY_RE = re.compile(r"/api/v1/preview/[A-Za-z0-9_-]{32}(?:/.*)?\Z")
MAX_BODY = 2000
MAX_CONFIG = 1024 * 1024


class ConfigurationError(RuntimeError):
    pass


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("Invalid encoding")
    result = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if b64(result) != value:
        raise ValueError("Noncanonical encoding")
    return result


def safe_path(target):
    """Use the original URI, never a proxy's already-normalized pathname."""
    if not isinstance(target, str) or len(target) > 8192 or not target.startswith("/"):
        raise ValueError("Invalid path")
    if target.startswith("//") or re.search(r"[\\\x00-\x20\x7f]", target) or "#" in target:
        raise ValueError("Ambiguous path")
    path = target.split("?", 1)[0]
    if re.search(r"%(?![0-9a-fA-F]{2})", path):
        raise ValueError("Invalid escaping")
    segments = []
    for raw in path.split("/")[1:]:
        segment = unquote(raw, encoding="utf-8", errors="strict")
        if segment in (".", "..") or re.search(r"[/\\%\x00-\x1f\x7f]", segment):
            raise ValueError("Ambiguous path segment")
        segments.append(segment)
    if any(not part for part in segments[:-1]):
        raise ValueError("Empty path segment")
    return "/" + "/".join(segments)


class Gate:
    def __init__(self, secret_file, site_host, cookie_ttl=604800, clock=time.time):
        if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?", site_host):
            raise ValueError("GATE_SITE_HOST must be a hostname without scheme or port")
        if not 60 <= cookie_ttl <= 31 * 86400:
            raise ValueError("Cookie lifetime must be 60 seconds to 31 days")
        self.secret_file = Path(secret_file)
        self.site_host = site_host.lower()
        self.cookie_ttl = cookie_ttl
        self.clock = clock

    def config(self):
        try:
            return self.read_config()
        except (OSError, ValueError, KeyError, TypeError, UnicodeError):
            raise ConfigurationError("Preview access configuration unavailable") from None

    def read_config(self):
        # Re-open on every check: atomic rename/revocation takes effect immediately.
        with self.secret_file.open("rb") as source:
            raw = source.read(MAX_CONFIG + 1)
        if len(raw) > MAX_CONFIG:
            raise ValueError("Configuration too large")
        data = json.loads(raw)
        key = unb64(data["signing_key"])
        invites = data["invites"]
        if len(key) < 32 or not isinstance(invites, list) or len(invites) > 1000:
            raise ValueError("Invalid configuration")
        seen = set()
        for invite in invites:
            digest = invite["token_sha256"]
            if (not isinstance(digest, str) or not HASH_RE.fullmatch(digest)
                    or digest in seen or type(invite["expires_at"]) is not int
                    or type(invite.get("revoked", False)) is not bool):
                raise ValueError("Invalid invitation configuration")
            seen.add(digest)
        return key, invites

    def active_invite(self, invites, digest, now):
        result = None
        for invite in invites:
            equal = hmac.compare_digest(invite["token_sha256"], digest)
            if equal and not invite.get("revoked", False) and invite["expires_at"] > now:
                result = invite
        return result

    def exchange(self, token):
        if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
            return None
        key, invites = self.config()
        now = int(self.clock())
        digest = hashlib.sha256(token.encode("ascii")).hexdigest()
        invite = self.active_invite(invites, digest, now)
        if invite is None:
            return None
        expires = min(now + self.cookie_ttl, invite["expires_at"])
        payload = b64(json.dumps({"v": 1, "h": digest, "iat": now, "exp": expires},
                                 separators=(",", ":"), sort_keys=True).encode())
        value = payload + "." + b64(hmac.digest(key, payload.encode(), "sha256"))
        return f"{COOKIE}={value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={expires - now}"

    def authorized(self, cookie_headers):
        key, invites = self.config()
        # Duplicate credentials fail closed rather than depending on parser ordering.
        raw = "; ".join(cookie_headers)
        if len(raw) > 8192 or len(re.findall(r"(?:^|;)\s*" + re.escape(COOKIE) + r"=", raw)) != 1:
            return False
        try:
            parsed = SimpleCookie(raw)
            value = parsed[COOKIE].value
            payload, signature = value.split(".")
            actual = unb64(signature)
            if not hmac.compare_digest(hmac.digest(key, payload.encode(), "sha256"), actual):
                return False
            data = json.loads(unb64(payload))
            now = int(self.clock())
            if (set(data) != {"v", "h", "iat", "exp"} or data["v"] != 1
                    or type(data["iat"]) is not int or type(data["exp"]) is not int
                    or not isinstance(data["h"], str) or not HASH_RE.fullmatch(data["h"])
                    or not data["iat"] <= now < data["exp"]
                    or not 0 < data["exp"] - data["iat"] <= self.cookie_ttl):
                return False
            invite = self.active_invite(invites, data["h"], now)
            return invite is not None and data["exp"] <= invite["expires_at"]
        except (ValueError, KeyError, TypeError, UnicodeError):
            return False


def page(message="This preview is open to invited testers. Enter your access code to continue."):
    # All caller messages are fixed text; never echo a submitted token or request URI.
    template = Path(__file__).with_name("access.html").read_text()
    return template.replace("{{MESSAGE}}", message).encode()


class GateServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, address, gate, timeout=5):
        self.gate = gate
        self.request_timeout = timeout
        self.slots = threading.BoundedSemaphore(32)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close()
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

    def handle_error(self, request, client_address):
        # Base implementation dumps tracebacks/request context. Do not leak URLs.
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = "PreviewGate"
    sys_version = ""
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(self.server.request_timeout)
        self.deadline = threading.Timer(self.server.request_timeout, self.expire_request)
        self.deadline.daemon = True
        self.deadline.start()

    def expire_request(self):
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def finish(self):
        self.deadline.cancel()
        super().finish()

    def log_message(self, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.respond(code, b"Request could not be accepted.", "text/plain; charset=utf-8")

    def respond(self, status, body=b"", content_type="text/html; charset=utf-8", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self.close_connection = True

    def dispatch(self):
        try:
            path = safe_path(self.path)
            if path == "/healthz" and self.command in ("GET", "HEAD"):
                self.server.gate.config()
                return self.respond(200, b"ok", "text/plain")
            if path == "/check" and self.command == "GET":
                original = self.headers.get("X-Forwarded-Uri", "")
                checked = safe_path(original)
                # Prefix must also be literal, not percent-encoded into a bypass.
                capability = (original.split("?", 1)[0].startswith("/api/v1/preview/")
                              and CAPABILITY_RE.fullmatch(checked))
                if capability or self.server.gate.authorized(self.headers.get_all("Cookie", [])):
                    return self.respond(204)
                return self.respond(403, page())
            if path == "/_preview/access" and self.command in ("GET", "HEAD"):
                return self.respond(200, page())
            if path.startswith("/_preview/access/") and self.command == "GET":
                # Only a literal URL-safe token is accepted; queries never carry it.
                if self.path != path:
                    return self.respond(400, page("Use the complete invitation link or enter your access code below."))
                token = path.removeprefix("/_preview/access/")
                return self.exchange(token)
            if path == "/_preview/access" and self.command == "POST":
                origin = self.headers.get("Origin")
                if origin != "https://" + self.server.gate.site_host:
                    return self.respond(403, page("Open your invitation on this preview site, then try again."))
                if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
                    return self.respond(400)
                length = int(self.headers["Content-Length"])
                if not 0 < length <= MAX_BODY:
                    return self.respond(413)
                if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/x-www-form-urlencoded":
                    return self.respond(415)
                body = self.rfile.read(length)
                if len(body) != length:
                    return self.respond(400)
                fields = parse_qs(body.decode("utf-8"), strict_parsing=True, max_num_fields=2)
                if set(fields) != {"code"} or len(fields["code"]) != 1:
                    return self.respond(400)
                return self.exchange(fields["code"][0].strip())
            return self.respond(404, b"Not found", "text/plain")
        except (socket.timeout, TimeoutError):
            return self.respond(408)
        except (ValueError, UnicodeError):
            return self.respond(400, page("This request could not be accepted. Open your invitation again."))
        except (ConfigurationError, OSError, KeyError, TypeError):
            return self.respond(503, page("Preview access is temporarily unavailable. Please try again shortly."))

    def exchange(self, token):
        cookie = self.server.gate.exchange(token)
        if cookie is None:
            return self.respond(403, page("This access code is invalid or has expired. Ask the preview owner for a new invitation."))
        return self.respond(303, headers={"Set-Cookie": cookie, "Location": "/"})

    do_GET = dispatch
    do_HEAD = dispatch
    do_POST = dispatch
    do_OPTIONS = dispatch


if __name__ == "__main__":
    gate = Gate(os.environ.get("GATE_SECRET_FILE", "/run/secrets/preview-gate.json"),
                os.environ["GATE_SITE_HOST"], int(os.environ.get("GATE_COOKIE_TTL_SECONDS", "604800")))
    gate.config()  # Invalid/missing configuration must not start a permissive server.
    GateServer(("0.0.0.0", int(os.environ.get("GATE_PORT", "8080"))), gate).serve_forever()
