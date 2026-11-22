#!/usr/bin/env python3
"""Build only the reviewed Lambda source, with stable ZIP metadata and no secrets."""
import hashlib
from pathlib import Path
import zipfile


def build(destination=None):
    folder = Path(__file__).resolve().parent
    destination = Path(destination) if destination else folder.parents[2] / ".preview/cognito/migration.zip"
    destination.parent.mkdir(parents=True, exist_ok=True)
    info = zipfile.ZipInfo("migration.py", (2026, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(info, (folder / "migration.py").read_bytes())
    return destination


if __name__ == "__main__":
    result = build()
    print(f"Built {result.name}: sha256={hashlib.sha256(result.read_bytes()).hexdigest()}")
