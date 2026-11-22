"""Install the reviewed runner manifest into a Linux image, without host bytes."""

import json
import platform
import subprocess
import sys
from pathlib import Path


def main(runtime=None):
    runtime = Path(runtime) if runtime is not None else Path("/runner/runtime")
    manifest = json.loads((runtime / "manifest.json").read_text())
    sys.path.insert(0, "/runner")
    import runtime_manifest
    import runtime_dependencies

    if sys.version_info[:2] != runtime_dependencies.REQUIRED_PYTHON:
        raise RuntimeError(f"The sandbox runtime requires Python {runtime_dependencies.REQUIRED_PYTHON_VERSION}.")
    node_version = subprocess.check_output(["node", "--version"], text=True).strip()
    if not node_version.startswith(f"v{runtime_dependencies.REQUIRED_NODE_MAJOR}."):
        raise RuntimeError(f"The sandbox runtime requires Node.js {runtime_dependencies.REQUIRED_NODE_MAJOR}.")
    if platform.machine() not in {"aarch64", "arm64"}:
        raise RuntimeError("The MicroVM image must be built for ARM64.")
    # The existing runtime validator remains the single reviewed allowlist.
    problems = [runtime_manifest.check_python_spec(spec) for spec in manifest["python"]["packages"]]
    problems += [runtime_manifest.check_node_package(name, version)
                 for name, version in manifest["node"]["packages"].items()]
    problems += [runtime_manifest.check_tool(name, version) for name, version in manifest["tools"].items()]
    problems = [problem for problem in problems if problem]
    if problems:
        raise RuntimeError("Runtime manifest validation failed: " + "; ".join(problems))
    expected_digest = runtime_manifest.digest({
        "python": manifest["python"], "node": {**manifest["node"], "tools": manifest["tools"]}
    })
    if manifest.get("digest") != expected_digest:
        raise RuntimeError("The runtime manifest pins do not match their digest.")
    fingerprints = runtime_dependencies.lock_fingerprints(manifest)
    if manifest.get("dependencyLocks") != fingerprints:
        raise RuntimeError("The runtime manifest does not match the reviewed dependency locks.")
    runtime_dependencies.prepare_runtime(runtime)
    runtime_dependencies.install_python(manifest, runtime / "python")
    runtime_dependencies.install_node(manifest, runtime / "node")
    runtime_dependencies.install_esbuild(manifest, runtime / "bin")
    # Platform and provenance now describe the bytes this image really holds.
    installed_manifest = {
        **manifest,
        "platform": "linux-arm64",
        "dependencyLocks": runtime_dependencies.lock_fingerprints(manifest),
    }
    (runtime / "manifest.json").write_text(json.dumps(installed_manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
