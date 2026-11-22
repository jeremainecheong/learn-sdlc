"""Put something in the database, so the app has something to show.

    python3 ops/seed.py

Three lists and ten tasks, some of them late, one of them finished. Running it
twice does nothing the second time, so it is safe to put in front of a server
that may already have been started.
"""

import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if __package__ in (None, ""):
    sys.path.insert(0, str(ROOT))

from api.db import init_db, open_connection  # noqa: E402
from api.repository import comments, lists, tasks  # noqa: E402

# Days from today, so the overdue report has something in it whenever this
# runs. LEARNSDLC_NOW pins the day when a run needs to be repeatable.
SEED = [
    ("Home", [
        ("Renew the passport", "high", -9, ["errand"], False),
        ("Pay the rent", "high", -2, ["money"], False),
        ("Book the dentist", "medium", 3, ["health"], False),
        ("Water the plants", "low", None, [], False),
    ]),
    ("Work", [
        ("Write the release notes", "high", -1, ["release"], False),
        ("Review the migration plan", "medium", 1, ["release", "review"], False),
        ("Update the runbook", "medium", 8, ["ops"], False),
        ("Archive the old dashboards", "low", None, ["ops"], True),
    ]),
    ("Reading", [
        ("Finish the sqlite paper", "medium", -4, ["study"], False),
        ("Start the testing chapter", "low", 14, ["study"], False),
    ]),
]


def today():
    """The day the seed data is measured from."""
    pinned = os.environ.get("LEARNSDLC_NOW")
    return datetime.fromisoformat(pinned).date() if pinned else date.today()


def seed(conn):
    """Write the sample data and return how much of it there is."""
    made = today()
    first = None
    for name, entries in SEED:
        created = lists.create_list(conn, name)
        for title, priority, offset, tags, done in entries:
            due = (made + timedelta(days=offset)).isoformat() if offset is not None else None
            task = tasks.create_task(conn, created["id"], title, priority, due, tags)
            first = first or task
            if done:
                tasks.complete_task(conn, task["id"])
    comments.add_comment(
        conn, first["id"], "sam",
        "The renewal form needs a photo taken in the last six months.",
    )
    return len(SEED), sum(len(entries) for _, entries in SEED)


def main():
    conn = open_connection()
    try:
        init_db(conn)
        if lists.list_lists(conn):
            print("seed: this database already has lists, so nothing was added")
            return 0
        list_count, task_count = seed(conn)
        print(f"seed: {list_count} lists, {task_count} tasks")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
