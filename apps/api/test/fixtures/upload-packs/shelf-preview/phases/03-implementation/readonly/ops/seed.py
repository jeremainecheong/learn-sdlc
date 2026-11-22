"""Prepare the shelf before the preview starts.

The shelf keeps its books in memory, so there is nothing to write ahead of the
service, and the preview always opens on an empty shelf: this says so in one
line and exits 0. Run it with `python3 ops/seed.py`.
"""

import sys


def main():
    print("shelf seed: in-memory shelf, nothing to write")
    return 0


if __name__ == "__main__":
    sys.exit(main())
