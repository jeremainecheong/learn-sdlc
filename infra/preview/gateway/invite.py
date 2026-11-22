"""Local invitation administration. Writes private files; never prints tokens."""
import argparse
import fcntl
import hashlib
import json
import os
import secrets
import stat
import tempfile
import time
from pathlib import Path

from gate import Gate, b64


def atomic_json(path, value):
    path = Path(path)
    previous = path.stat() if path.exists() else None
    descriptor, temporary = tempfile.mkstemp(prefix=".preview-gate-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as target:
            # Preserve a deployed gate-readable owner/group on atomic rotation.
            # New files start private; the operator sets UID10001 before mounting.
            if previous:
                if stat.S_IMODE(previous.st_mode) & 0o007:
                    raise ValueError("Gate configuration must not be world-accessible")
                if os.geteuid() == 0:
                    os.fchown(target.fileno(), previous.st_uid, previous.st_gid)
            os.fchmod(target.fileno(), stat.S_IMODE(previous.st_mode) if previous else 0o600)
            json.dump(value, target, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--secret-file", required=True)
    parser.add_argument("--site-host", required=True)
    parser.add_argument("--output", required=True, help="New private JSON file receiving invitation URL/code; never VCS.")
    parser.add_argument("--days", type=int, default=7)
    args = parser.parse_args()
    if not 1 <= args.days <= 31:
        parser.error("Use 1–31 days.")
    target = Path(args.output)
    config_path = Path(args.secret_file)
    if config_path.resolve() == target.resolve():
        parser.error("Invitation output must be separate from the gate configuration.")
    gate = Gate(config_path, args.site_host)
    # Serialize distinct invitations so concurrent local operator commands do
    # not overwrite each other's freshly added hashes.
    lock_fd = os.open(str(config_path) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        issue(config_path, target, gate, args.days)
    print("Invitation written to the requested private file. Gate configuration updated; no token printed.")


def issue(config_path, target, gate, days):
    if target.exists():
        raise ValueError("Output already exists; use a new private filename.")
    if config_path.exists():
        gate.config()
        config = json.loads(config_path.read_text())
    else:
        config = {"signing_key": b64(secrets.token_bytes(32)), "invites": []}
    if len(config["invites"]) >= 1000:
        raise ValueError("Retire expired invitations before adding more.")
    code = secrets.token_urlsafe(32)
    digest = hashlib.sha256(code.encode()).hexdigest()
    expires = int(time.time()) + days * 86400
    # Reserve output without overwriting another operator's file.
    with target.open("x") as result:
        os.chmod(target, 0o600)
        json.dump({"url": f"https://{gate.site_host}/_preview/access/{code}",
                   "code": code, "token_sha256": digest, "expires_at": expires}, result, indent=2)
        result.write("\n")
    config["invites"].append({"token_sha256": digest, "expires_at": expires, "revoked": False})
    atomic_json(config_path, config)


if __name__ == "__main__":
    main()
