"""The deployment selfcheck: can the web service reach the api service?

    python3 ops/selfcheck.py --selfcheck

It reads deploy/services.json. When the web service's API_URL is plain
http://<service name>:<port>, naming the api service and its port, it prints one line and exits 0:

    deadline selfcheck: web reaches api at <API_URL>

Otherwise it prints the fault in one sentence and exits 1.
"""

import json
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "deploy" / "services.json"
LOOPBACK = ("localhost", "127.0.0.1", "0.0.0.0")


def fault(config):
    """The first fault in the settings, as a sentence, or None when they hang together."""
    services = config.get("services") if isinstance(config, dict) else None
    if not isinstance(services, dict):
        return "deploy/services.json has no services"
    api, web = services.get("api"), services.get("web")
    if not isinstance(api, dict) or not isinstance(web, dict):
        return "deploy/services.json needs an api service and a web service"
    port = api.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        return f"the api service's port {port!r} is not a port"
    url = (web.get("env") or {}).get("API_URL")
    if not isinstance(url, str) or not url.strip():
        return "the web service has no API_URL"
    address = urlparse(url)
    if address.hostname in LOOPBACK:
        return f"web's API_URL {url} points at the web container itself; name the api service instead"
    if address.hostname != "api":
        return f"web's API_URL {url} does not name the api service"
    called = address.port or 80
    if called != port:
        return f"web calls api on port {called}, but api listens on port {port}"
    if url.removesuffix("/") != f"http://api:{port}":
        return f"web's API_URL {url} should be plain http://<service name>:<port>"
    return None


def main():
    try:
        config = json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        print(f"deadline selfcheck: cannot read deploy/services.json: {err}", file=sys.stderr)
        return 1
    problem = fault(config)
    if problem:
        print(f"deadline selfcheck: {problem}", file=sys.stderr)
        return 1
    url = config["services"]["web"]["env"]["API_URL"]
    print(f"deadline selfcheck: web reaches api at {url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
