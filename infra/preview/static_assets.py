#!/usr/bin/env python3
"""Retain only immutable Next build assets across a release cutover of the reference deployment.

No application process runs during export. Docker identities are checked before
copying, and only the resulting public/_next/static tree is routed by Caddy.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid

GRACE = 24 * 60 * 60
MAX_FILES = 12000
MAX_BYTES = 512 * 1024 * 1024
MAX_EXPORT = 128 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
CONTAINER = "learnsdlc-cloud-preview-web-1"
IMAGE = re.compile(r"learnsdlc-cloud-web:learnsdlc-[a-f0-9]{64}")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
EXTENSIONS = {".js", ".css", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".wasm"}


def safe_path(value):
    if (not isinstance(value, str) or len(value) > 1024
            or any(not re.fullmatch(r"[A-Za-z0-9_@()\[\].-]{1,200}", part)
                   or part.startswith(".") for part in value.split("/"))):
        raise RuntimeError("Unsafe static asset path")
    return Path(value)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def assets(directory):
    """Validate the entire exported tree before allowing any publication."""
    found = {}
    total = 0
    for root, directories, files in os.walk(directory, followlinks=False):
        for name in directories + files:
            path = Path(root) / name
            relative = path.relative_to(directory).as_posix()
            safe_path(relative)
            if path.is_symlink() or not (path.is_file() or path.is_dir()):
                raise RuntimeError("Static exports may contain only regular files and directories")
        for name in files:
            path = Path(root) / name
            if path.suffix not in EXTENSIONS:
                continue  # In particular, do not retain source maps or HTML.
            size = path.stat().st_size
            total += size
            if size > MAX_FILE or total > MAX_BYTES or len(found) >= MAX_FILES:
                raise RuntimeError("Static asset export exceeds its bounded size")
            found[path.relative_to(directory).as_posix()] = {"sha256": digest(path), "size": size, "source": path}
    if not found:
        raise RuntimeError("The web image has no supported static assets")
    return found


class Store:
    def __init__(self, root):
        self.root = Path(root)
        if self.root.is_symlink():
            raise RuntimeError("Static asset root must not be a symlink")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o750)
        self.root.chmod(0o750)

    @contextmanager
    def locked(self):
        with (self.root / "lock").open("a+b") as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def read(self):
        metadata = self.root / "manifest.json"
        if not metadata.exists():
            return {"schema": 1, "activeImage": None, "pending": None, "files": {}}
        if metadata.is_symlink() or metadata.stat().st_size > 4 * 1024 * 1024:
            raise RuntimeError("Static manifest is invalid")
        value = json.loads(metadata.read_text())
        if (value.get("schema") != 1 or not isinstance(value.get("files"), dict)
                or len(value["files"]) > MAX_FILES):
            raise RuntimeError("Static manifest is invalid")
        for name, entry in value["files"].items():
            path = self.root / "public/_next/static" / safe_path(name)
            if (path.suffix not in EXTENSIONS or not path.is_file() or path.is_symlink()
                    or any(parent.is_symlink() for parent in path.parents if parent != self.root and self.root in parent.parents)
                    or entry.get("size") != path.stat().st_size or entry.get("sha256") != digest(path)
                    or (entry.get("expiresAt") is not None and type(entry["expiresAt"]) not in (int, float))):
                raise RuntimeError("Retained static asset integrity check failed")
            entry["source"] = path
        return value

    def publish(self, state):
        if len(state["files"]) > MAX_FILES or sum(item["size"] for item in state["files"].values()) > MAX_BYTES:
            raise RuntimeError("Retained static assets exceed the bounded capacity")
        required = sum(item["size"] for item in state["files"].values()) + 128 * 1024 * 1024
        if shutil.disk_usage(self.root).free < required:
            raise RuntimeError("Insufficient disk space for static asset retention")
        public = self.root / "public/_next/static"
        for ancestor in (self.root / "public", self.root / "public/_next", public):
            if ancestor.is_symlink() or (ancestor.exists() and not ancestor.is_dir()):
                raise RuntimeError("Unexpected link or file in retained static directory")
        public.mkdir(parents=True, exist_ok=True)
        # Validate existing directories before adding bytes; the private host
        # owns this tree. A symlink may never redirect writes outside it.
        for directory, children, files in os.walk(self.root / "public", followlinks=False):
            if Path(directory).is_symlink() or any((Path(directory) / name).is_symlink() for name in children + files):
                raise RuntimeError("Unexpected link in retained static directory")
        for name, entry in state["files"].items():
            target = public / safe_path(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                if not target.is_file() or target.stat().st_size != entry["size"] or digest(target) != entry["sha256"]:
                    raise RuntimeError("Different bytes claim the same immutable static URL")
                continue
            temporary = target.with_name("pending-" + uuid.uuid4().hex)
            try:
                with temporary.open("xb") as output, entry["source"].open("rb") as source:
                    shutil.copyfileobj(source, output)
                    output.flush()
                    os.fchmod(output.fileno(), 0o444)
                    os.fsync(output.fileno())
                if temporary.stat().st_size != entry["size"] or digest(temporary) != entry["sha256"]:
                    raise RuntimeError("Static export changed during publication")
                # Link is an atomic add, and cannot overwrite an existing URL.
                os.link(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        for directory, _, _ in os.walk(self.root / "public"):
            Path(directory).chmod(0o755)
            descriptor = os.open(directory, os.O_RDONLY)
            try: os.fsync(descriptor)
            finally: os.close(descriptor)
        serial = {**state, "files": {name: {k: v for k, v in entry.items() if k != "source"}
                                      for name, entry in state["files"].items()}}
        temporary = self.root / ("manifest-" + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("x") as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(serial, stream, sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.root / "manifest.json")
            descriptor = os.open(self.root, os.O_RDONLY)
            try: os.fsync(descriptor)
            finally: os.close(descriptor)
        finally:
            temporary.unlink(missing_ok=True)
        # Only after the new manifest commits may retired/unreferenced bytes
        # disappear. This also cleans additions left by a pre-commit crash.
        for directory, _, files in os.walk(public):
            for filename in files:
                path = Path(directory) / filename
                name = path.relative_to(public).as_posix()
                if name not in state["files"]:
                    path.unlink()

    def prepare(self, running_image, old_assets, new_image, new_assets, now=None):
        now = time.time() if now is None else now
        with self.locked():
            state = self.read()
            for incoming in (old_assets, new_assets):
                for name, item in incoming.items():
                    previous = state["files"].get(name)
                    if previous and (previous["sha256"], previous["size"]) != (item["sha256"], item["size"]):
                        raise RuntimeError("Different bytes claim the same immutable static URL")
                    expiry = previous["expiresAt"] if previous else now + GRACE
                    if incoming is new_assets and expiry is not None:
                        expiry = max(expiry, now + GRACE)
                    state["files"][name] = {**item, "expiresAt": expiry}
            for name, item in state["files"].items():
                if name in old_assets:
                    item["expiresAt"] = None
                elif item["expiresAt"] is None:
                    item["expiresAt"] = now + GRACE
            state.update(activeImage=running_image, pending={"image": new_image, "files": sorted(new_assets)})
            state["files"] = {name: item for name, item in state["files"].items()
                              if item["expiresAt"] is None or item["expiresAt"] > now or name in new_assets}
            self.publish(state)

    def reconcile(self, running_image, expected=None, now=None):
        now = time.time() if now is None else now
        with self.locked():
            state = self.read()
            if expected is not None and running_image != expected:
                raise RuntimeError("Expected web image is not running; existing assets retained")
            pending = state["pending"]
            if pending and running_image == pending["image"]:
                for name, item in state["files"].items():
                    if name in pending["files"]:
                        item["expiresAt"] = None
                    elif item["expiresAt"] is None:
                        item["expiresAt"] = now + GRACE
                state.update(activeImage=running_image, pending=None)
            elif running_image != state["activeImage"]:
                raise RuntimeError("Running web image has no verified static inventory")
            state["files"] = {name: item for name, item in state["files"].items()
                              if item["expiresAt"] is None or item["expiresAt"] > now}
            # A failed cutover's staged-only assets expire; it must be prepared
            # again before a later activation rather than claiming missing bytes.
            if pending and state["pending"] and not set(pending["files"]) <= state["files"].keys():
                state["pending"] = None
            self.publish(state)


def docker(*args):
    result = subprocess.run(["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if result.returncode:
        raise RuntimeError("Static asset Docker operation failed")
    if len(result.stdout) > 1024 * 1024:
        raise RuntimeError("Static asset Docker metadata exceeded its bound")
    return result.stdout.decode().strip()


def image_id(image):
    if not IMAGE.fullmatch(image): raise RuntimeError("Expected an exact preview web release image")
    value = docker("image", "inspect", "--format", "{{.Id}}", image)
    if not DIGEST.fullmatch(value): raise RuntimeError("Invalid web image identity")
    return value


def running():
    # List by exact name first so an absent first deployment is distinguishable
    # from a Docker failure, permission error, or malformed container identity.
    identity = docker("ps", "-a", "--filter", "name=^/" + CONTAINER + "$", "--format", "{{.ID}}")
    if not identity: return None
    if not re.fullmatch(r"[a-f0-9]{12,64}", identity): raise RuntimeError("Ambiguous running web identity")
    raw = docker("inspect", "--format", '{{json .Image}}|{{json .State.Running}}|{{json .Config.Labels}}', identity)
    image, active, labels = [json.loads(part) for part in raw.split("|", 2)]
    if (not DIGEST.fullmatch(image) or active is not True
            or labels.get("com.docker.compose.project") != "learnsdlc-cloud-preview"
            or labels.get("com.docker.compose.service") != "web"):
        raise RuntimeError("Existing web container is not the running preview service")
    return image


def export(image, directory):
    if not DIGEST.fullmatch(image): raise RuntimeError("Static export requires an immutable image ID")
    name = "learnsdlc-static-export-" + uuid.uuid4().hex
    created = False
    try:
        # Record attempted creation before calling: even an ambiguous CLI
        # response must clean up exactly this uniquely named stopped container.
        created = True
        docker("create", "--name", name, "--label", "learnsdlc.static-export=" + name,
               "--pull=never", "--network", "none", "--entrypoint", "/bin/false", image)
        archive = directory / "export.tar"
        with archive.open("xb") as output:
            process = subprocess.Popen(["docker", "cp", name + ":/app/apps/web/.next/static", "-"],
                                       stdout=output, stderr=subprocess.DEVNULL, start_new_session=True)
            deadline = time.monotonic() + 60
            try:
                while process.poll() is None:
                    if time.monotonic() >= deadline or os.fstat(output.fileno()).st_size > MAX_EXPORT + 16 * 1024 * 1024:
                        raise RuntimeError("Static image archive exceeded its time or size bound")
                    time.sleep(.05)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        if process.returncode or archive.stat().st_size > MAX_EXPORT + 16 * 1024 * 1024:
            raise RuntimeError("Static image export failed or exceeded its bound")
        destination = directory / "assets"
        destination.mkdir(mode=0o700)
        count = total = 0
        with tarfile.open(archive) as tar:
            for member in tar:
                path = safe_path(member.name.rstrip("/"))
                if path.parts[0] != "static" or not (member.isdir() or member.isfile()):
                    raise RuntimeError("Unsafe static export archive")
                if len(path.parts) == 1:
                    if not member.isdir(): raise RuntimeError("Invalid static export root")
                    continue
                target = destination.joinpath(*path.parts[1:])
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                count += 1
                total += member.size
                if count > MAX_FILES or member.size > MAX_FILE or total > MAX_EXPORT:
                    raise RuntimeError("Static export archive exceeds its bounded size")
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as output, tar.extractfile(member) as source:
                    shutil.copyfileobj(source, output)
        return assets(destination)
    finally:
        if created:
            # Never rm a live service, volumes, images, or another export name.
            docker("rm", "-v", name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "activate", "prune"))
    parser.add_argument("--image")
    parser.add_argument("--root", type=Path, default=Path("/srv/learnsdlc/next-static"))
    args = parser.parse_args()
    os.umask(0o077)
    store = Store(args.root)
    current = running()
    if args.action == "prepare":
        expected = image_id(args.image or "")
        if shutil.disk_usage(store.root).free < MAX_BYTES + 2 * MAX_EXPORT + 128 * 1024 * 1024:
            raise RuntimeError("Insufficient disk headroom for bounded image exports")
        with tempfile.TemporaryDirectory(prefix="export-", dir=store.root) as folder:
            private = Path(folder)
            new = private / "new"; new.mkdir()
            old = private / "old"; old.mkdir()
            new_assets = export(expected, new)
            old_assets = export(current, old) if current and current != expected else new_assets if current else {}
            store.prepare(current, old_assets, expected, new_assets)
    else:
        expected = image_id(args.image or "") if args.action == "activate" else None
        store.reconcile(current, expected)
    print("Verified immutable static asset " + args.action + " completed; no application data copied")


if __name__ == "__main__":
    try: main()
    except Exception:
        raise SystemExit("Static asset retention failed; deployment must stop (no raw provider or container output)")
