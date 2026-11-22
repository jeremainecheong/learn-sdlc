"""The clock your tests read. Pin it in the Run clock control, not in the code.

A test that names a fixed date rots. A test that reads the machine's clock is a
different test every day. Reading the clock through one function is how a real
suite stays honest, and it is why `overdue_tasks` takes the day as an argument
instead of asking the operating system for it.
"""

import os
from datetime import date, datetime


def today() -> date:
    """The day this run is happening on.

    The Run clock control writes LEARNSDLC_NOW when you pin a date; with nothing
    pinned this is the machine's own date, and your suite is a different suite
    tomorrow.
    """
    pinned = os.environ.get("LEARNSDLC_NOW")
    return datetime.fromisoformat(pinned).date() if pinned else date.today()
