"""The one command that asks whether this deployment hangs together.

    python3 api/main.py --selfcheck

Five questions, in the order an operator would ask them at three in the
morning: does the API still build, does the database have its tables, does the
compose file tell the web service where the API is, is that address a service
this file actually defines, and was anything ever built for the browser.

On success it prints one line:

    selfcheck: web reaches api, 13 routes, 5 tables

On failure it prints one sentence naming the fault and exits 1.
"""

import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
if __package__ in (None, ""):
    sys.path.insert(0, str(ROOT))

from api.db import init_db, open_connection  # noqa: E402
from api.main import create_app  # noqa: E402

COMPOSE_FILE = ROOT / "docker-compose.yml"
BUNDLE_FILE = ROOT / "web" / "dist" / "app.js"


class SelfcheckError(Exception):
    """A fault worth waking somebody for, written as the sentence they read."""


# ---------------------------------------------------------------- compose ---
# A compose file is YAML, and PyYAML is a compiled dependency this application
# would otherwise not have. The subset a compose file uses is small: nested
# mappings, sequences, and the inline [a, b] and {a: b} forms.


def _strip_comment(raw):
    if raw.lstrip().startswith("#"):
        return ""
    if '"' not in raw and "'" not in raw:
        hash_at = raw.find("#")
        if hash_at == 0 or (hash_at > 0 and raw[hash_at - 1].isspace()):
            return raw[:hash_at].rstrip()
    return raw.rstrip()


def _split_flow(text):
    """Split "a, {b: c}, [d, e]" on the commas that are not inside a bracket."""
    parts, depth, start = [], 0, 0
    for at, character in enumerate(text):
        if character in "[{":
            depth += 1
        elif character in "]}":
            depth -= 1
        elif character == "," and depth == 0:
            parts.append(text[start:at])
            start = at + 1
    parts.append(text[start:])
    return [part.strip() for part in parts if part.strip()]


def _value(text):
    """One scalar, or one inline list or mapping."""
    text = text.strip()
    if text.startswith("[") and text.endswith("]"):
        return [_value(part) for part in _split_flow(text[1:-1])]
    if text.startswith("{") and text.endswith("}"):
        inline = {}
        for part in _split_flow(text[1:-1]):
            key, _, rest = part.partition(":")
            inline[key.strip()] = _value(rest)
        return inline
    if len(text) > 1 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    return text


def _block(lines, index, indent):
    """Everything at this indentation, as a list or a mapping, and where it ends."""
    if index < len(lines) and lines[index][1].startswith("- "):
        items = []
        while (
            index < len(lines)
            and lines[index][0] == indent
            and lines[index][1].startswith("- ")
        ):
            body = lines[index][1][2:].strip()
            index += 1
            if body:
                items.append(_value(body))
            elif index < len(lines) and lines[index][0] > indent:
                nested, index = _block(lines, index, lines[index][0])
                items.append(nested)
            else:
                items.append(None)
        return items, index
    mapping = {}
    while (
        index < len(lines)
        and lines[index][0] == indent
        and not lines[index][1].startswith("- ")
    ):
        key, _, rest = lines[index][1].partition(":")
        index += 1
        rest = rest.strip()
        if rest:
            mapping[key.strip()] = _value(rest)
        elif index < len(lines) and (
            lines[index][0] > indent or lines[index][1].startswith("- ")
        ):
            mapping[key.strip()], index = _block(lines, index, lines[index][0])
        else:
            mapping[key.strip()] = None
    return mapping, index


def read_compose(path):
    """The compose file as nested dictionaries and lists."""
    if not Path(path).is_file():
        raise SelfcheckError(
            f"no {Path(path).name} here, so there is no deployment to check"
        )
    lines = []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        clean = _strip_comment(raw)
        if clean.strip():
            lines.append((len(clean) - len(clean.lstrip(" ")), clean.strip()))
    if not lines:
        raise SelfcheckError(f"{Path(path).name} is empty")
    parsed, _ = _block(lines, 0, lines[0][0])
    return parsed if isinstance(parsed, dict) else {}


def environment_of(service):
    """A service's environment, whether it was written as a map or as a list."""
    declared = service.get("environment") or {}
    if isinstance(declared, dict):
        return {str(key): str(value) for key, value in declared.items()}
    pairs = {}
    for entry in declared:
        key, _, value = str(entry).partition("=")
        pairs[key.strip()] = value.strip()
    return pairs


def _port(text):
    try:
        return int(str(text).strip())
    except (TypeError, ValueError):
        return 0


def service_ports(service):
    """Every port a service answers on inside the compose network."""
    found = set()
    for entry in service.get("ports") or []:
        found.add(_port(str(entry).split("/")[0].split(":")[-1]))
    for entry in service.get("expose") or []:
        found.add(_port(str(entry).split("/")[0]))
    declared = environment_of(service).get("PORT")
    if declared:
        found.add(_port(declared))
    return {number for number in found if number}


# ----------------------------------------------------------------- checks ---


def count_routes(app=None):
    """How many operations the API publishes: one per method and path."""
    app = app or create_app()
    operations = set()
    for rule in app.url_map.iter_rules():
        if not rule.rule.startswith("/api"):
            continue
        for method in rule.methods - {"HEAD", "OPTIONS"}:
            operations.add((method, rule.rule))
    return len(operations)


def count_tables():
    """How many tables the database has, making them first if it is empty."""
    conn = open_connection()
    try:
        return init_db(conn)
    finally:
        conn.close()


def web_reaches_api(compose=None):
    """Whether the web service can reach the API it proxies to, and by what name."""
    compose = compose if compose is not None else read_compose(COMPOSE_FILE)
    services = compose.get("services") or {}
    web = services.get("web")
    if not isinstance(web, dict):
        raise SelfcheckError(
            "web cannot reach api — this compose file defines no web service"
        )
    url = environment_of(web).get("API_URL", "")
    if not url:
        raise SelfcheckError(
            "web cannot reach api — the web service has no API_URL, so the proxy "
            "has nowhere to send /api"
        )
    address = urlparse(url)
    host = address.hostname or ""
    if host not in services:
        raise SelfcheckError(
            f'web cannot reach api — API_URL names "{host}", which is not a '
            "service in this compose file"
        )
    wanted = address.port or (443 if address.scheme == "https" else 80)
    exposed = service_ports(services[host])
    if exposed and wanted not in exposed:
        raise SelfcheckError(
            f"web cannot reach api — API_URL asks for port {wanted}, which the "
            f'"{host}" service does not expose'
        )
    return host


def selfcheck():
    """Run every check and print the one line that says how it went."""
    try:
        routes = count_routes()
        tables = count_tables()
        web_reaches_api()
    except SelfcheckError as fault:
        print(f"selfcheck: {fault}")
        return 1
    if not BUNDLE_FILE.is_file():
        # A note and not a fault: the API is complete without the bundle, and
        # the build check runs before anything has been built for the browser.
        print("selfcheck: note, web/dist/app.js is missing, so npm run build has not run")
    print(f"selfcheck: web reaches api, {routes} routes, {tables} tables")
    return 0


if __name__ == "__main__":
    sys.exit(selfcheck())
