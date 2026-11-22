"""Opt-in isolated Docker integration. Never contacts LearnSDLC or AWS.

Run after building learnsdlc-preview-gate:local; requires Caddy locally.
All containers/networks are temporary and only random loopback ports are bound.
"""
import hashlib
import http.client
import importlib.util
import json
import os
import secrets
import ssl
import subprocess
import tempfile
import time
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[3]
    env = os.environ.copy()
    env.setdefault("DOCKER_CONFIG", str(root / "data/docker-client"))
    # Docker Desktop's per-user socket when it exists and the shell names no
    # other engine; otherwise Docker's own context decides (Linux, Colima).
    desktop_socket = Path.home() / ".docker/run/docker.sock"
    if "DOCKER_HOST" not in env and desktop_socket.exists():
        env["DOCKER_HOST"] = "unix://" + str(desktop_socket)
    prefix = "learnsdlc-gate-test-" + secrets.token_hex(5)
    containers = []
    observations = []

    def docker(*args):
        result = subprocess.run(["docker", *args], env=env, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError("Disposable Docker command failed: " + result.stderr[:500])
        return (result.stdout + (result.stderr if args[0] == "logs" else "")).strip()

    def start(suffix, *args):
        name = prefix + "-" + suffix
        containers.append(name)
        docker("run", "-d", "--name", name, "--network", prefix, *args)
        return name

    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        observations.append(name)

    with tempfile.TemporaryDirectory(prefix="learnsdlc-gate-test-") as directory:
        temp = Path(directory)
        # Only fabricated local credentials, not deployment secrets.
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        config = {"signing_key": secrets.token_urlsafe(32),
                  "invites": [{"token_sha256": digest, "expires_at": int(time.time()) + 3600}]}
        (temp / "preview-gate.json").write_text(json.dumps(config))
        os.chmod(temp, 0o755)
        os.chmod(temp / "preview-gate.json", 0o644)
        retained = temp / "retained"
        asset_spec = importlib.util.spec_from_file_location("retained_assets", root / "infra/preview/static_assets.py")
        asset_module = importlib.util.module_from_spec(asset_spec)
        asset_spec.loader.exec_module(asset_module)
        asset_store = asset_module.Store(retained)
        old_build = temp / "old-build"
        (old_build / "chunks").mkdir(parents=True)
        old_script = b'window.oldDocumentLoaded = true;'
        (old_build / "chunks/old-aaa.js").write_bytes(old_script)
        dynamic_chunk = old_build / "chunks/app/workspace/[phaseId]/page-abc.js"
        dynamic_chunk.parent.mkdir(parents=True)
        dynamic_chunk.write_bytes(b"window.dynamicRouteLoaded = true;")
        old_assets = asset_module.assets(old_build)
        old_image, new_image = "sha256:" + "a" * 64, "sha256:" + "b" * 64
        old_umask = os.umask(0o077)
        try:
            asset_store.prepare(old_image, old_assets, old_image, old_assets)
            asset_store.reconcile(old_image, old_image)
        finally:
            os.umask(old_umask)
        public = retained / "public/_next/static/chunks"
        # Even accidentally placed non-asset files must not be file-served.
        (public / "old.html").write_bytes(b"retired private HTML canary")
        (public / "old.js.map").write_bytes(b"source map canary")
        (retained / "private-control.json").write_bytes(b"private manifest canary")
        # This Docker Desktop engine does not publish ports on --internal
        # bridges. Only loopback ports are published; Caddy uses a local CA.
        docker("network", "create", prefix)
        try:
            gate_name = start("gate", "--network-alias", "preview-gate", "--read-only", "--cap-drop", "ALL",
                             "--security-opt", "no-new-privileges:true", "-e", "GATE_SITE_HOST=localhost",
                             "-v", f"{temp}:/run/secrets:ro", "learnsdlc-preview-gate:local")
            start("upstream", "--network-alias", "api", "--network-alias", "web", "--read-only",
                  "--cap-drop", "ALL", "-v", f"{Path(__file__).with_name('test_upstream.py')}:/tmp/upstream.py:ro",
                  "learnsdlc-preview-gate:local", "python", "/tmp/upstream.py")
            caddy_name = start("caddy", "-e", "SITE_HOST=localhost", "-p", "127.0.0.1::443",
                               "-p", "127.0.0.1::80", "--tmpfs", "/data", "--tmpfs", "/config",
                               "-v", f"{retained}:/retained-static:ro",
                               "-v", f"{root / 'infra/preview/Caddyfile'}:/etc/caddy/Caddyfile:ro", "caddy:2-alpine")
            ports = json.loads(docker("inspect", caddy_name))[0]["NetworkSettings"]["Ports"]
            port = int(ports["443/tcp"][0]["HostPort"])
            http_port = int(ports["80/tcp"][0]["HostPort"])

            def request(path, method="GET", headers=None, body=None, plain=False):
                if plain:
                    client = http.client.HTTPConnection("127.0.0.1", http_port, timeout=5)
                else:
                    client = http.client.HTTPSConnection("localhost", port, timeout=5, context=ssl._create_unverified_context())
                client.request(method, path, headers={"Host": "localhost", **(headers or {})}, body=body)
                response = client.getresponse()
                result = response.status, dict(response.getheaders()), response.read()
                client.close()
                return result

            for attempt in range(40):
                try:
                    if request("/_preview/access")[0] == 200:
                        break
                except (OSError, http.client.HTTPException):
                    pass
                time.sleep(0.25)
            else:
                raise AssertionError("Disposable TLS endpoint did not become ready")
            check("Compose Caddy admin health probe succeeds", docker("exec", caddy_name, "wget", "--spider", "-q", "http://127.0.0.1:2019/config/") == "")
            adapted = json.loads(docker("exec", caddy_name, "caddy", "adapt", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"))
            def stream_limits(value):
                if isinstance(value, dict):
                    return ([value["stream_timeout"]] if "stream_timeout" in value else []) + [item for child in value.values() for item in stream_limits(child)]
                if isinstance(value, list):
                    return [item for child in value for item in stream_limits(child)]
                return []
            check("API streams require reconnect within5minutes", stream_limits(adapted) == [300000000000])
            status, headers, body = request("/", plain=True)
            check("HTTP redirects to HTTPS", status == 308 and headers["Location"].startswith("https://localhost"))
            for path in ["/", "/api/v1/auth/me", "/api/v1/enrollments/mine", "/socket.io/?EIO=4&transport=polling", "/check", "/healthz", "/_next/static/chunks/old-aaa.js"]:
                status, headers, body = request(path, headers={"Authorization": "Bearer test-only-jwt", "X-Forwarded-Uri": "/api/v1/preview/" + "A" * 32})
                check("Protected without cookie: " + path.split("?")[0], status == 403 and b"Private preview" in body)
            for path in ["/api/v1/auth/cognito/migrate", "/api/v1/auth/cognito/migrate/other"]:
                status, _, _ = request(path)
                check("Cognito service exception does not open GET " + path, status == 403)
            status, _, body = request("/api/v1/auth/cognito/migrate", "POST", {
                "Authorization": "Bearer fixture-never-forward", "Cookie": "untrusted=fixture",
                "Content-Type": "application/json"}, '{"fixture":"migration-proof-required-by-api"}')
            data = json.loads(body)
            check("Only the exact Cognito service POST reaches its API proof check", status == 200 and data["upstream"] == "api" and data["body"] == '{"fixture":"migration-proof-required-by-api"}')
            check("Cognito migration never forwards browser session credentials", data["authorization"] is None and data["cookie"] is None)
            status, headers, body = request("/_preview/access/" + token)
            check("URL exchange redirects safely", status == 303 and headers["Location"] == "/" and token.encode() not in body)
            check("Cookie flags preserved through Caddy", all(value in headers["Set-Cookie"] for value in ["__Host-learnsdlc-preview=", "Secure", "HttpOnly", "Path=/", "SameSite=Lax"]))
            cookie = headers["Set-Cookie"].split(";", 1)[0]
            for method in ("GET", "HEAD"):
                status, headers, body = request("/_next/static/chunks/old-aaa.js?cutover=old", method, {"Cookie": cookie})
                check("Retained immutable old-document script " + method,
                      status == 200 and (body == old_script if method == "GET" else body == b"")
                      and "javascript" in headers["Content-Type"] and headers["X-Content-Type-Options"] == "nosniff"
                      and "no-store" in headers["Cache-Control"])
            for path in ("/_next/static/chunks/old.html", "/_next/static/chunks/old.js.map", "/_next/static/chunks/missing.js", "/login"):
                status, _, body = request(path, headers={"Cookie": cookie})
                check("Only supported existing static files are retained: " + path,
                      status == 200 and json.loads(body)["upstream"] == "web"
                      and b"canary" not in body)
            status, _, body = request("/_next/static/chunks/app/workspace/%5BphaseId%5D/page-abc.js", headers={"Cookie": cookie})
            check("Encoded Next dynamic-route chunk path serves exact immutable bytes", status == 200 and body == b"window.dynamicRouteLoaded = true;")
            status, _, body = request("/_next/static/../../manifest.json", headers={"Cookie": cookie})
            check("Original-URI traversal remains rejected even with invitation", status == 400 and b"canary" not in body and b'"upstream"' not in body)
            status, _, body = request("/_next/static/chunks/old-aaa.js", "POST", {"Cookie": cookie}, "not a static request")
            check("Static retention never intercepts POST", status == 200 and json.loads(body)["upstream"] == "web")
            next_public = temp / "next-build/chunks"
            next_public.mkdir(parents=True)
            (next_public / "old-aaa.js").write_bytes(old_script)
            (next_public / "new-bbb.js").write_bytes(b"window.newDocumentLoaded = true;")
            served_inode = docker("exec", caddy_name, "stat", "-c", "%i", "/retained-static/public")
            old_umask = os.umask(0o077)
            try:
                asset_store.prepare(old_image, old_assets, new_image, asset_module.assets(next_public.parent))
                asset_store.reconcile(new_image, new_image)
            finally:
                os.umask(old_umask)
            check("Read-only serving directory keeps the same inode across asset publication",
                  docker("exec", caddy_name, "stat", "-c", "%i", "/retained-static/public") == served_inode)
            for file, content in (("old-aaa.js", old_script), ("new-bbb.js", b"window.newDocumentLoaded = true;")):
                status, _, body = request("/_next/static/chunks/" + file, headers={"Cookie": cookie})
                check("Both sides of immutable asset cutover stay loadable: " + file, status == 200 and body == content)
            status, headers, body = request("/_preview/access", "POST", {"Origin": "https://localhost", "Content-Type": "application/x-www-form-urlencoded"}, "code=" + token)
            check("Native form exchange succeeds", status == 303)
            for path, expected in [("/dashboard", "web"), ("/api/v1/auth/me", "api"), ("/socket.io/?EIO=4&transport=polling", "api")]:
                status, headers, body = request(path, headers={"Cookie": cookie, "Authorization": "Bearer test-only-jwt"})
                data = json.loads(body)
                check("Authenticated routing: " + expected + path.split("?")[0], status == 200 and data["upstream"] == expected)
                check("Bearer unchanged: " + path.split("?")[0], data["authorization"] == "Bearer test-only-jwt")
                check("Private response headers: " + path.split("?")[0], "no-store" in headers["Cache-Control"] and headers["Referrer-Policy"] == "no-referrer" and "noindex" in headers["X-Robots-Tag"])
            status, _, body = request("/api/v1/profile", "POST", {"Cookie": cookie, "Authorization": "Bearer test-only-jwt", "Content-Type": "application/json"}, '{"test":"unchanged body"}')
            check("Forward auth leaves POST body intact", status == 200 and json.loads(body)["body"] == '{"test":"unchanged body"}')
            cap = "A" * 32
            for method in ["GET", "OPTIONS", "POST"]:
                status, _, body = request(f"/api/v1/preview/{cap}/api/tasks", method, {"Origin": "null"})
                data = json.loads(body)
                check("Opaque capability " + method, status == 200 and data["upstream"] == "api" and data["origin"] == "null" and data["method"] == method)
            for suffix in ["/../auth/me", "/%2e%2e/auth/me", "/%252e%252e/auth/me", "/%2f..%2fauth/me", "/%5c..%5cauth/me", "//api"]:
                status, _, body = request(f"/api/v1/preview/{cap}" + suffix)
                check("Traversal denied: " + suffix, status == 400 and b'"upstream"' not in body)
            for path in ["/%61pi/v1/preview/" + cap, "/api/v1/preview/short", "/api/v1/preview"]:
                check("No expanded capability exception: " + path, request(path)[0] == 403)
            ws_headers = {"Cookie": cookie, "Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13"}
            check("WebSocket upgrade passes behind gate", request("/socket.io/?EIO=4&transport=websocket", headers=ws_headers)[0] == 101)
            ws_headers.pop("Cookie")
            check("WebSocket upgrade blocked without invitation", request("/socket.io/?EIO=4&transport=websocket", headers=ws_headers)[0] == 403)
            config["invites"][0]["revoked"] = True
            replacement = temp / "next.json"
            replacement.write_text(json.dumps(config))
            os.chmod(replacement, 0o644)
            replacement.replace(temp / "preview-gate.json")
            revocation_response = request("/dashboard", headers={"Cookie": cookie})
            check("Revocation immediately denies upstream access", revocation_response[0] in (403, 503) and b'"upstream"' not in revocation_response[2])
            # Docker Desktop's host bind-mount rename briefly returns ENOENT:
            # retain that503 as fail-closed evidence, then require an exact403
            # after the replacement is visible inside the container. No cache
            # delay is added to the service, and no successful access is allowed.
            check("Container observes the revoked record", docker("exec", gate_name, "python", "-c", "from gate import Gate; _, invites = Gate('/run/secrets/preview-gate.json','localhost').config(); print(invites[0]['revoked'])") == "True")
            check("Settled atomic revocation returns403", request("/dashboard", headers={"Cookie": cookie})[0] == 403)
            check("Revoked invitation cannot read retained static assets", request("/_next/static/chunks/old-aaa.js", headers={"Cookie": cookie})[0] == 403)
            docker("stop", gate_name)
            check("Gate outage fails closed", request("/dashboard", headers={"Cookie": cookie})[0] == 502)
            request("/_preview/access/" + token)
            logs = docker("logs", caddy_name)
            check("Invitation and capability absent from proxy logs", token not in logs and cap not in logs and "test-only-jwt" not in logs)
            print(json.dumps({"status": "passed", "observations": observations, "count": len(observations),
                              "first_post_rename_status": revocation_response[0],
                              "scope": "disposable Docker Caddy + gate + fabricated upstream; no AWS/application calls"}, indent=2))
        except Exception:
            # Fake fixture diagnostics only; redact credentials even in failures.
            for name in containers:
                for args in [("inspect", "--format", "{{json .State}} {{json .NetworkSettings.Ports}}", name), ("logs", name)]:
                    output = docker(*args).replace(token, "[redacted]").replace(config["signing_key"], "[redacted]")
                    print(name + ": " + output[:3000])
            raise
        finally:
            for name in reversed(containers):
                subprocess.run(["docker", "rm", "-f", "-v", name], env=env, capture_output=True)
            subprocess.run(["docker", "network", "rm", prefix], env=env, capture_output=True)


if __name__ == "__main__":
    main()
