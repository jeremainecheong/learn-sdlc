"""What the sandbox is allowed to pre-bake, where the baked bytes live, and how
the two ends agree that they are the same bytes.

A pack declares what it needs in `project.json`'s `runtime` block, and the pack
is content. Content is not a place to add a dependency: a new library inside the
sandbox is a code change with a review, because it is a new pile of code running
next to a learner's. This module is where that review lands. The loader checks
every declared package against these lists at boot, `scripts/prebake.mjs` checks
them again before it installs anything, and neither will install a name that is
not written down here.

The versions are not here on purpose. The pack pins them, exactly, because the
pack is what a learner's phase is written against; this file says only which
names may appear. The one exception is esbuild, which is a native binary rather
than a directory of Python: its checksums are pinned per platform below, so a
downloaded binary that is not the one we reviewed fails `prebake verify` rather
than running.
"""

import hashlib
import json
import os
import platform
import re
import sys

# Python packages the runner may bake. They are installed from the hash-pinned
# wheels in runtime-locks/python-requirements.txt. markupsafe ships a separate
# wheel per platform, so the layer is baked on the platform that runs it: the
# runner image bakes its own inside Linux rather than copying the host's.
#
# flask and its five dependencies are what the canonical application imports;
# pytest, its three helpers and Pygments run and format the learner's suites.
ALLOWED_PYTHON = frozenset({
    "flask",
    "werkzeug",
    "jinja2",
    "itsdangerous",
    "click",
    "markupsafe",
    "blinker",
    "pytest",
    "pluggy",
    "iniconfig",
    "packaging",
    "pygments",
})

# Node packages the runner may bake. react and react-router-dom are what the
# canonical front end imports; jsdom and the two Testing Library packages are
# what its unit tests need in order to render a component at all.
ALLOWED_NODE = frozenset({
    "react",
    "react-dom",
    "react-router-dom",
    "jsdom",
    "@testing-library/react",
    "@testing-library/dom",
})

# Tools are executables, not libraries, and each one is a separate decision.
ALLOWED_TOOLS = frozenset({"esbuild"})

# sha256 of the `bin/esbuild` inside @esbuild/<platform>@<version>, per platform
# we support. A tool is a binary we hand untrusted input to, so "the registry
# said this was esbuild" is not the same claim as "this is the binary we read
# the release notes for".
ESBUILD_CHECKSUMS = {
    "0.25.0": {
        "darwin-arm64": "9e297058b6101e29f672a1a4739e4305daab8a79d31ca09878e69fc9fd8f9f91",
        "linux-x64": "98f635ee88526a7d9dd7a82c8a79f341c0247de8aa56d38158c0963892957829",
        "linux-arm64": "a52e9fd41809ef39c0019c41695717ab4cf681639ad08c7e9531ce810d6ac943",
    },
    "0.24.2": {
        "darwin-arm64": "6820034f50c56ec43c5bce2d71583ab0923e55b11476841c0424173f889044a9",
        "linux-x64": "75d1eba922507d7bd02cafe0bccd6c5ff8c8a427b34a700494c8f913328ce430",
        "linux-arm64": "68381efed35ab17f2f5785183f1d7677ead7a14bb9eee91dead04869b6459e63",
    },
}

# "flask==3.0.3": a name, two equals signs, an exact version. A range would make
# what a learner runs depend on the day the image was built.
PYTHON_SPEC = re.compile(r"^([a-z0-9][a-z0-9._-]*)==([0-9][0-9A-Za-z.+-]*)$")
# "18.3.1" or "6.28.0": an exact semver, never "^18" or "~18.3".
NODE_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")

RUNTIME_DIRNAME = "runtime"


def runtime_root():
    """Where the pre-baked layer lives.

    `RUNNER_RUNTIME_DIR` is read here and nowhere else, so a deployment that
    bakes the layer somewhere other than beside this file (the Lambda package
    does) has one knob rather than four.
    """
    override = os.environ.get("RUNNER_RUNTIME_DIR")
    if override:
        return os.path.abspath(override)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), RUNTIME_DIRNAME)


def python_dir(root=None):
    return os.path.join(root or runtime_root(), "python")


def manifest_path(root=None):
    return os.path.join(root or runtime_root(), "manifest.json")


def platform_key():
    """The esbuild package suffix for this machine, or None where we have none.

    Only three platforms are supported: a developer's
    Apple Silicon laptop, the runner container, and an arm64 container.
    """
    system = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    machine = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(
        platform.machine().lower()
    )
    if system is None or machine is None:
        return None
    key = f"{system}-{machine}"
    return key if key in {"darwin-arm64", "linux-x64", "linux-arm64"} else None


def check_python_spec(spec):
    """None when the pinned spec may be baked, else the sentence saying why not."""
    match = PYTHON_SPEC.match(spec or "")
    if not match:
        return (
            f'"{spec}" is not a pinned Python package. Write it as name==version, '
            "for example flask==3.0.3."
        )
    name = match.group(1)
    if name not in ALLOWED_PYTHON:
        return (
            f'"{name}" is not on the runner\'s Python allowlist. Adding a package to the '
            "sandbox is a code change: add it to ALLOWED_PYTHON in "
            "apps/api/runner/runtime_manifest.py with a review."
        )
    return None


def check_node_package(name, version):
    """None when the pinned Node package may be baked, else the sentence."""
    if name not in ALLOWED_NODE:
        return (
            f'"{name}" is not on the runner\'s Node allowlist. Adding a package to the '
            "sandbox is a code change: add it to ALLOWED_NODE in "
            "apps/api/runner/runtime_manifest.py with a review."
        )
    if not NODE_VERSION.match(version or ""):
        return (
            f'"{name}" is pinned to "{version}", which is not an exact version. '
            "Write 18.3.1, not ^18.3.1."
        )
    return None


def check_tool(name, version):
    """None when the pinned tool may be baked, else the sentence."""
    if name not in ALLOWED_TOOLS:
        return (
            f'"{name}" is not on the runner\'s tool allowlist. A tool is a binary the '
            "sandbox hands untrusted input to: add it to ALLOWED_TOOLS in "
            "apps/api/runner/runtime_manifest.py with a review."
        )
    if not NODE_VERSION.match(version or ""):
        return f'"{name}" is pinned to "{version}", which is not an exact version.'
    if name == "esbuild" and version not in ESBUILD_CHECKSUMS:
        return (
            f"esbuild {version} has no reviewed checksum. Add one per platform to "
            "ESBUILD_CHECKSUMS in apps/api/runner/runtime_manifest.py."
        )
    return None


def digest_lines(runtime):
    """The exact lines the digest is taken over.

    Written out rather than hashed straight from the JSON so that the Node
    script and this module can be shown to agree: `test_runtime_manifest.py`
    asserts `node scripts/prebake.mjs print` returns what this computes. A
    digest the two ends disagree about is worse than no digest at all.
    """
    python = runtime.get("python") or {}
    node = runtime.get("node") or {}
    lines = [f"python {python.get('version', '')}"]
    lines.extend(sorted(python.get("packages") or []))
    lines.append(f"node {node.get('version', '')}")
    lines.extend(sorted(f"{n}@{v}" for n, v in (node.get("packages") or {}).items()))
    lines.extend(sorted(f"tool:{n}@{v}" for n, v in (node.get("tools") or {}).items()))
    return lines


def digest(runtime):
    """sha256 over the sorted pinned specs: the cache key and the drift check."""
    payload = "\n".join(digest_lines(runtime)) + "\n"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def main(argv=None):
    """`python3 runtime_manifest.py print`: the allowlists, for a human.

    The module is a data file with functions; this exists so an operator asking
    "what is the sandbox allowed to install?" has a command rather than a grep,
    and scripts/prebake.mjs reads the same output. The baked esbuild binary is
    checked against ESBUILD_CHECKSUMS by runtime_dependencies.install_esbuild,
    which every bake calls.

    `print` (or no command at all) is the only command. Anything else exits 2
    with the usage line, so a caller that expects a check this module does not
    offer fails instead of reading the printed allowlists as a pass.
    """
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv not in ([], ["print"]):
        print("usage: runtime_manifest.py [print]", file=sys.stderr)
        return 2
    print(json.dumps({
        "python": sorted(ALLOWED_PYTHON),
        "node": sorted(ALLOWED_NODE),
        "tools": sorted(ALLOWED_TOOLS),
        "esbuild": sorted(ESBUILD_CHECKSUMS),
        "checksums": {"esbuild": ESBUILD_CHECKSUMS},
        "platform": platform_key(),
        "runtimeRoot": runtime_root(),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
