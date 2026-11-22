"""Install the reviewed runtime lockfiles; never resolve learner dependencies.

Both the local prebake and image builders use this module. The content pack
still owns the direct pins. Lockfiles additionally bind every downloaded wheel
and npm transitive dependency, and a mismatching pack fails before installation.
"""

import argparse
import base64
from contextlib import contextmanager
import fcntl
import gzip
import hashlib
import importlib.metadata
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import tarfile
import urllib.request
import uuid

LOCK_ROOT = Path(__file__).resolve().parent / "runtime-locks"
FILES = ("python-requirements.txt", "package.json", "package-lock.json")
PYTHON_LINE = re.compile(r"^([a-z0-9][a-z0-9._-]*)==([0-9][0-9A-Za-z.+-]*)(?: --hash=sha256:[a-f0-9]{64})+$")

#: The interpreters the sandbox runtime is built and verified with. The content
#: pack's manifest names the same versions, and a mismatch on either side stops
#: the build before anything is installed.
REQUIRED_PYTHON = (3, 11)
REQUIRED_PYTHON_VERSION = ".".join(str(part) for part in REQUIRED_PYTHON)
REQUIRED_NODE_MAJOR = 22


def require(condition, message):
    if not condition:
        raise ValueError(message)


def python_matches(manifest):
    """Whether the manifest and this interpreter both name REQUIRED_PYTHON."""
    return manifest["python"].get("version") == REQUIRED_PYTHON_VERSION and sys.version_info[:2] == REQUIRED_PYTHON


def normalized(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def sha512_integrity(value):
    if not isinstance(value, str) or not value.startswith("sha512-"):
        return False
    try:
        return len(base64.b64decode(value[7:], validate=True)) == 64
    except ValueError:
        return False


def read_locks(manifest, root=None):
    root = Path(root) if root is not None else LOCK_ROOT
    require(root.is_dir() and not root.is_symlink(), "Runtime dependency lock directory is missing or linked.")
    sources = {}
    for name in FILES:
        path = root / name
        require(path.is_file() and not path.is_symlink(), "A runtime dependency lockfile is missing or linked.")
        raw = path.read_bytes()
        require(len(raw) <= 2 * 1024 * 1024, "Runtime dependency lockfile is too large.")
        sources[name] = raw
    python = {}
    for line in sources["python-requirements.txt"].decode("utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        match = PYTHON_LINE.fullmatch(line)
        require(match is not None, "Python runtime locks must use exact pins and SHA256 wheel hashes.")
        name, version = normalized(match[1]), match[2]
        require(name not in python, "Python runtime lock contains a duplicate package.")
        python[name] = version
    declared_python = {}
    for spec in manifest["python"]["packages"]:
        parts = spec.split("==")
        require(len(parts) == 2, "Python runtime package is not exactly pinned.")
        name = normalized(parts[0])
        require(name not in declared_python, "Python runtime manifest contains duplicate packages.")
        declared_python[name] = parts[1]
    require(python == declared_python, "Python dependency lock does not match the content pack pins.")
    package = json.loads(sources["package.json"])
    lock = json.loads(sources["package-lock.json"])
    dependencies = manifest["node"]["packages"]
    require(package.get("private") is True and package.get("dependencies") == dependencies,
            "Node dependency lock does not match the content pack pins.")
    require(not any(package.get(k) for k in ("scripts", "devDependencies", "optionalDependencies", "overrides", "workspaces")),
            "Runtime package manifest contains unreviewed install configuration.")
    require(lock.get("lockfileVersion") == 3, "Runtime npm lockfile must use version 3.")
    packages = lock.get("packages", {})
    require(isinstance(packages, dict) and packages.get("", {}).get("dependencies") == dependencies,
            "Runtime npm lockfile root differs from the content pack.")
    for path, entry in packages.items():
        if path == "":
            continue
        require(path.startswith("node_modules/") and not any(part in {"", ".", ".."} for part in path.split("/"))
                and "\\" not in path, "Unsafe path in runtime npm lockfile.")
        require(isinstance(entry, dict) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", entry.get("version", "")) is not None
                and not entry.get("link"),
                "Runtime npm lockfile contains a non-registry dependency.")
        require(re.fullmatch(r"https://registry\.npmjs\.org/[^?#\\\s]+\.tgz", entry.get("resolved", "")) is not None
                and sha512_integrity(entry.get("integrity")),
                "Runtime npm packages must have registry URLs and SHA512 integrity.")
    for name, version in dependencies.items():
        require(packages.get("node_modules/" + name, {}).get("version") == version,
                "Runtime npm lockfile omits a declared exact package.")
    return {"root": root, "sources": sources, "python": python, "package": package, "nodeLock": lock}


def lock_fingerprints(manifest, root=None):
    locks = read_locks(manifest, root)
    return {name: hashlib.sha256(raw).hexdigest() for name, raw in locks["sources"].items()}


def verify_python(target, expected):
    """Check the complete installed set and dependencies, not just importability."""
    target = Path(target).resolve()
    distributions = list(importlib.metadata.distributions(path=[str(target)]))
    installed = {}
    for distribution in distributions:
        name = normalized(distribution.metadata["Name"])
        require(name not in installed, "Runtime contains duplicate Python distributions.")
        installed[name] = distribution.version
    require(installed == expected, "Installed Python distributions differ from the reviewed lock.")
    # packaging itself is one of the reviewed, installed dependencies. Only its
    # metadata parser is used; no learner modules are imported by the builder.
    previous = list(sys.path)
    try:
        sys.path.insert(0, str(target))
        from packaging.requirements import Requirement
        from packaging.specifiers import SpecifierSet
        for distribution in distributions:
            requires_python = distribution.metadata.get("Requires-Python")
            require(not requires_python or SpecifierSet(requires_python).contains(".".join(map(str, sys.version_info[:3]))),
                    "An installed runtime package does not support the builder's Python version.")
            for raw in distribution.requires or []:
                requirement = Requirement(raw)
                if requirement.marker and not requirement.marker.evaluate({"extra": ""}):
                    continue
                name = normalized(requirement.name)
                require(name in installed and requirement.specifier.contains(installed[name], prereleases=True),
                        "Python runtime lock does not satisfy an installed package dependency.")
    finally:
        sys.path[:] = previous
    return installed


def node_inventory(target):
    target = Path(target)
    found = {}

    def modules(directory):
        require(directory.is_dir() and not directory.is_symlink(), "Node dependency directory is missing or linked.")
        for entry in directory.iterdir():
            if entry.name == ".bin":
                continue  # npm's executable links are not dependency packages.
            if entry.name == ".package-lock.json" and entry.is_file() and not entry.is_symlink():
                continue
            require(entry.is_dir() and not entry.is_symlink(), "Unexpected or linked Node dependency entry.")
            children = list(entry.iterdir()) if entry.name.startswith("@") else [entry]
            for package in children:
                require(package.is_dir() and not package.is_symlink(), "Linked Node dependency directory.")
                metadata = package / "package.json"
                require(metadata.is_file() and not metadata.is_symlink(), "Node package metadata is missing or linked.")
                found[package.relative_to(target).as_posix()] = json.loads(metadata.read_text())["version"]
                nested = package / "node_modules"
                if nested.exists() or nested.is_symlink():
                    modules(nested)

    modules(target / "node_modules")
    return found


def verify_node(target, lock):
    target = Path(target).resolve()
    installed = {}
    for relative, entry in lock["packages"].items():
        if not relative:
            continue
        path = target / relative / "package.json"
        require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(target),
                "An installed Node dependency is missing or linked outside the runtime.")
        version = json.loads(path.read_text())["version"]
        require(version == entry["version"], "Installed Node dependency differs from the reviewed lock.")
        installed[relative] = version
    require(node_inventory(target) == installed, "Installed Node inventory contains unreviewed dependencies.")
    return installed


def prepare_runtime(target):
    """Claim an empty directory, or recognize a previously generated runtime."""
    target = Path(os.path.abspath(target))
    require(all(not path.is_symlink() for path in (target, *target.parents)), "Runtime path has a linked ancestor.")
    require(target.parent != target, "A filesystem root cannot be a runtime directory.")
    if not target.exists():
        target.mkdir(parents=True)
    require(target.is_dir(), "Runtime installation root is not a directory.")
    marker = target / ".learnsdlc-runtime.json"
    owner = {"owner": "learnsdlc-prebake", "schema": 1}
    if marker.exists():
        require(marker.is_file() and not marker.is_symlink() and json.loads(marker.read_text()) == owner,
                "Runtime ownership marker is invalid.")
        return target
    contents = list(target.iterdir())
    if contents:
        manifest_path = target / "manifest.json"
        require(manifest_path.is_file() and not manifest_path.is_symlink(), "Refusing to claim a nonempty unrelated directory.")
        manifest = json.loads(manifest_path.read_text())
        require(isinstance(manifest.get("python", {}).get("packages"), list)
                and isinstance(manifest.get("node", {}).get("packages"), dict)
                and re.fullmatch(r"[a-f0-9]{64}", manifest.get("digest", "")) is not None,
                "Existing directory does not contain a generated LearnSDLC runtime.")
    with marker.open("x") as out:
        json.dump(owner, out)
    return target


def publish_permissions(stage):
    """Public dependency bytes must be readable by the guest's separate UID.

    tempfile intentionally creates a private staging directory. Keep it private
    while installing, then normalize only this verified dependency tree before
    the atomic rename. Never chmod its ancestors or follow a package link out.
    """
    stage = Path(stage)
    directories, files = [stage], []
    def unreadable(error):
        raise error
    for root, names, leaves in os.walk(stage, followlinks=False, onerror=unreadable):
        for name in names:
            path = Path(root) / name
            require(stat.S_ISDIR(path.lstat().st_mode), "Unsafe directory in runtime publication.")
            directories.append(path)
        for name in leaves:
            path = Path(root) / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                resolved = path.resolve()
                require(path.parent.name == ".bin" and resolved.is_relative_to(stage)
                        and resolved.is_file(), "Unsafe link in runtime publication.")
                continue
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                    "Unsafe file in runtime publication.")
            files.append((path, 0o755 if info.st_mode & 0o111 else 0o644))
    # Validate the complete tree before changing any modes. Files have no group
    # or world write permission, and setuid/setgid/sticky bits are stripped.
    for path, mode in files:
        path.chmod(mode)
    for path in reversed(directories):
        path.chmod(0o755)


@contextmanager
def staged_target(target, name):
    target = Path(os.path.abspath(target))
    require(target.name == name, "Runtime installation target must be the named dependency directory.")
    parent = prepare_runtime(target.parent)
    require(not target.is_symlink(), "Refusing a linked runtime installation target.")
    require(not target.exists() or target.is_dir(), "Runtime installation target is not a directory.")
    descriptor = os.open(parent / ".install.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    stage = backup = None
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stage = Path(tempfile.mkdtemp(prefix="." + name + "-stage-", dir=parent))
        yield stage
        publish_permissions(stage)
        if target.exists():
            backup = parent / ("." + name + "-previous-" + uuid.uuid4().hex)
            target.rename(backup)
        try:
            stage.rename(target)
            stage = None
        except BaseException:
            if backup is not None and not target.exists():
                backup.rename(target)
                backup = None
            raise
        if backup is not None:
            shutil.rmtree(backup)
    finally:
        if stage is not None:
            shutil.rmtree(stage)
        os.close(descriptor)


def install_python(manifest, target, root=None):
    locks = read_locks(manifest, root)
    require(python_matches(manifest), f"Build the sandbox Python runtime with Python {REQUIRED_PYTHON_VERSION}.")
    with staged_target(target, "python") as stage:
        subprocess.run([
            sys.executable, "-I", "-m", "pip", "--isolated", "install", "--no-cache-dir", "--disable-pip-version-check",
            "--no-compile", "--only-binary", ":all:", "--no-deps", "--require-hashes",
            "--index-url", "https://pypi.org/simple", "--target", str(stage),
            "-r", str(locks["root"] / "python-requirements.txt"),
        ], check=True)
        return verify_python(stage, locks["python"])


def install_node(manifest, target, root=None, npm_command=None):
    locks = read_locks(manifest, root)
    environment = {k: v for k, v in os.environ.items() if k not in {"NODE_OPTIONS", "NODE_PATH"}}
    version = subprocess.run(["node", "--version"], capture_output=True, text=True, check=True, env=environment).stdout.strip()
    require(manifest["node"].get("version") == str(REQUIRED_NODE_MAJOR)
            and re.fullmatch(rf"v{REQUIRED_NODE_MAJOR}\.[0-9]+\.[0-9]+", version) is not None,
            f"Build the sandbox Node runtime with Node.js {REQUIRED_NODE_MAJOR}.")
    with staged_target(target, "node") as stage:
        return install_node_stage(locks, stage, npm_command)


def install_node_stage(locks, target, npm_command):
    for name in ("package.json", "package-lock.json"):
        (target / name).write_bytes(locks["sources"][name])
    # A lock controls the entire graph. npm config must not redirect downloads
    # or run lifecycle scripts inherited from a developer's user configuration.
    environment = {k: v for k, v in os.environ.items() if not k.lower().startswith("npm_config_")
                   and k not in {"NODE_OPTIONS", "NODE_PATH"}}
    with tempfile.TemporaryDirectory(prefix="learnsdlc-npm-config-") as directory:
        for kind in ("USER", "GLOBAL"):
            config = Path(directory) / (kind.lower() + ".npmrc")
            config.write_text("")
            environment["NPM_CONFIG_" + kind + "CONFIG"] = str(config)
        subprocess.run([
            *(npm_command or ["npm"]), "ci", "--prefix", str(target), "--omit=dev", "--no-audit", "--no-fund",
            "--ignore-scripts", "--registry=https://registry.npmjs.org/",
        ], check=True, env=environment)
    return verify_node(target, locks["nodeLock"])


def fetch_public(url, maximum):
    with urllib.request.urlopen(url, timeout=30) as response:
        raw = response.read(maximum + 1)
    require(len(raw) <= maximum, "Runtime tool download exceeded its size limit.")
    return raw


def install_esbuild(manifest, target):
    # Loaded by file path rather than imported: scripts/prebake.mjs runs this
    # module with `python -I`, which leaves this directory off sys.path.
    spec = importlib.util.spec_from_file_location("reviewed_runtime_manifest", Path(__file__).with_name("runtime_manifest.py"))
    runtime_manifest = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime_manifest)
    version = (manifest.get("tools") or manifest["node"].get("tools", {})).get("esbuild")
    platform = runtime_manifest.platform_key()
    expected = runtime_manifest.ESBUILD_CHECKSUMS.get(version, {}).get(platform)
    require(isinstance(expected, str) and re.fullmatch(r"[a-f0-9]{64}", expected) is not None,
            "esbuild has no reviewed checksum for this version and platform.")
    metadata = json.loads(fetch_public("https://registry.npmjs.org/@esbuild%2F" + platform + "/" + version, 1024 * 1024))
    distribution = metadata.get("dist", {})
    url, integrity = distribution.get("tarball", ""), distribution.get("integrity", "")
    require(re.fullmatch(r"https://registry\.npmjs\.org/@esbuild/[^?#\\\s]+\.tgz", url) is not None,
            "esbuild must come from the official npm registry.")
    require(sha512_integrity(integrity), "esbuild archive integrity is missing.")
    raw = fetch_public(url, 32 * 1024 * 1024)
    require("sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode() == integrity,
            "esbuild archive integrity differs from its registry metadata.")
    # Bound all expanded bytes before tarfile parses PAX/GNU extension headers,
    # which are otherwise consumed internally before a member is yielded.
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
        expanded = compressed.read(48 * 1024 * 1024 + 1)
    require(len(expanded) <= 48 * 1024 * 1024, "esbuild expanded archive exceeds its size limit.")
    binary = None
    with tarfile.open(fileobj=io.BytesIO(expanded), mode="r|") as archive:
        total = 0
        for count, entry in enumerate(archive, 1):
            total += entry.size
            require(count <= 30 and 0 <= entry.size <= 32 * 1024 * 1024 and total <= 48 * 1024 * 1024,
                    "esbuild archive exceeds reviewed member or unpacked size limits.")
            if entry.name == "package/bin/esbuild":
                require(binary is None and entry.isfile() and entry.size > 0,
                        "esbuild archive does not contain one regular executable.")
                with archive.extractfile(entry) as source:
                    binary = source.read(32 * 1024 * 1024 + 1)
    require(binary is not None, "esbuild executable is missing from the archive.")
    require(hashlib.sha256(binary).hexdigest() == expected, "esbuild is not the binary we reviewed.")
    with staged_target(target, "bin") as stage:
        path = stage / "esbuild"
        path.write_bytes(binary)
        path.chmod(0o755)


def main():
    """The command line scripts/prebake.mjs drives, with the pack's runtime block on stdin.

    `prebake build` runs prepare and the three install actions, `prebake
    verify` runs verify-python and verify-node, and each reads the lock
    fingerprints with `locks`. The runner image and the microVM guest import
    the functions directly instead.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("locks", "prepare", "install-python", "install-node", "install-esbuild", "verify-python", "verify-node"))
    parser.add_argument("--target", type=Path)
    args = parser.parse_args()
    manifest = json.loads(sys.stdin.read(1024 * 1024))
    if args.action == "locks":
        print(json.dumps(lock_fingerprints(manifest), sort_keys=True))
    else:
        require(args.target is not None, "Runtime installation requires an explicit target.")
        if args.action == "prepare":
            prepare_runtime(args.target)
        elif args.action.startswith("install-"):
            action = {"install-python": install_python, "install-node": install_node, "install-esbuild": install_esbuild}[args.action]
            action(manifest, args.target)
        else:
            locks = read_locks(manifest)
            if args.action == "verify-python":
                require(python_matches(manifest),
                        f"Verify the sandbox Python runtime with Python {REQUIRED_PYTHON_VERSION}.")
                verify_python(args.target, locks["python"])
            else:
                verify_node(args.target, locks["nodeLock"])


if __name__ == "__main__":
    main()
