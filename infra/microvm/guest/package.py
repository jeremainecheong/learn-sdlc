"""Create a deterministic source ZIP for AWS; never traverse arbitrary files."""

import argparse
import hashlib
import importlib.util
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RUNNER_SOURCES = (
    "analyzer.py", "app_session.py", "lambda_handler.py", "runtime_dependencies.py",
    "runtime_manifest.py", "runtime_diagnostics.py", "sandbox_runner.py", "serve.py",
)


def source_files(root: Path) -> dict[str, Path]:
    guest = root / "infra/microvm/guest"
    runner = root / "apps/api/runner"
    files = {"Dockerfile": guest / "Dockerfile"}
    for name in ("gateway.py", "install_runtime.py"):
        files[f"infra/microvm/guest/{name}"] = guest / name
    for name in RUNNER_SOURCES:
        files[f"apps/api/runner/{name}"] = runner / name
    files["apps/api/runner/runtime/manifest.json"] = runner / "runtime/manifest.json"
    for name in ("python-requirements.txt", "package.json", "package-lock.json"):
        files[f"apps/api/runner/runtime-locks/{name}"] = runner / "runtime-locks" / name
    for name, path in files.items():
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Missing, linked, or out-of-tree build source: {name}")
    return files


def package(root: Path, output: Path) -> dict:
    files = source_files(root)
    manifest = json.loads(files["apps/api/runner/runtime/manifest.json"].read_text())
    # These are reviewed build helpers, imported only to validate metadata.
    # Neither validation function installs packages or accesses the network.
    modules = {}
    for name in ("runtime_manifest", "runtime_dependencies"):
        module_spec = importlib.util.spec_from_file_location(f"guest_package_{name}", files[f"apps/api/runner/{name}.py"])
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        modules[name] = module
    declared = json.loads((root / "content/tasktrackr/project.json").read_text())["runtime"]
    actual = {"python": manifest["python"], "node": {**manifest["node"], "tools": manifest["tools"]}}
    if actual != declared or modules["runtime_manifest"].digest(declared) != manifest.get("digest"):
        raise ValueError("The runtime manifest differs from the pins or digest content/tasktrackr/project.json declares. Rebuild the pre-baked runtime.")
    fingerprints = modules["runtime_dependencies"].lock_fingerprints(manifest, root / "apps/api/runner/runtime-locks")
    if manifest.get("dependencyLocks") != fingerprints:
        raise ValueError("The runtime manifest does not match the reviewed dependency lockfile hashes.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, path in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, path.read_bytes())
    return {"path": str(output.resolve()), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            "bytes": output.stat().st_size, "files": len(files), "runtimeDigest": manifest["digest"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(package(ROOT, args.output), indent=2))


if __name__ == "__main__":
    main()
