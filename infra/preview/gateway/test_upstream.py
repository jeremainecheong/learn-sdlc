"""Disposable routing fixture, never an application backend."""
import base64
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def answer(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            key = self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", base64.b64encode(hashlib.sha1(key.encode()).digest()).decode())
            self.end_headers()
            self.close_connection = True
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        data = json.dumps({"upstream": "api" if self.server.server_port == 4000 else "web",
                           "method": self.command, "path": self.path,
                           "authorization": self.headers.get("Authorization"),
                           "cookie": self.headers.get("Cookie"),
                           "origin": self.headers.get("Origin"), "body": body.decode()}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=3600")
        self.end_headers()
        self.wfile.write(data)

    do_GET = answer
    do_POST = answer
    do_OPTIONS = answer


if __name__ == "__main__":
    for port in [3000, 4000]:
        threading.Thread(target=ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever, daemon=True).start()
    threading.Event().wait()
