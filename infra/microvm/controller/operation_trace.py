"""Metadata from the owner-only UNIX transport, never from guest/source JSON."""
import json
import re


# The supervisor stages a guest may report. The controller is installed without the runner's source, so this is a
# copy of apps/api/runner/runtime_diagnostics.py's STAGES; test_operation_trace.py holds the two equal.
STAGES = frozenset({"prepare", "transform", "test-child", "smoke-child", "timeout", "cleanup", "complete", "unsupported"})


class InvalidTrace(ValueError):
    pass


def valid_owner_id(value):
    return isinstance(value, str) and re.fullmatch(r"(?:[0-9a-f]{24}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})", value) is not None


def parse_trace(raw, purpose):
    if raw is None:
        return None  # Operator probes and other callers without an application owner send no trace.
    if not isinstance(raw, str) or len(raw) > 512:
        raise InvalidTrace("invalid platform trace")
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise InvalidTrace("invalid platform trace") from None
    if (not isinstance(value, dict) or set(value) != {"attemptId", "kind", "ownerId", "stepId"}
            or value["kind"] != ("run" if purpose == "job" else "preview")
            or not isinstance(value["attemptId"], str)
            or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value["attemptId"])
            or not valid_owner_id(value["ownerId"])
            or not isinstance(value["stepId"], str)
            or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", value["stepId"])):
        raise InvalidTrace("invalid platform trace")
    return value


def safe_diagnostics(value):
    """Fixed numeric fields only; never retain guest prose, paths or identities."""
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        return None
    result = {"version": 1, "scope": "supervisor-observed-child", "cpuScope": "maximum-observed-child"}
    for key in ("wallMs", "cpuUserMs", "cpuSystemMs", "peakRssBytes", "samples"):
        number = value.get(key)
        if type(number) is int and 0 <= number <= 10**15:
            result[key] = number
    stages = []
    for item in value.get("stages", [])[:16] if isinstance(value.get("stages"), list) else []:
        if (isinstance(item, dict) and item.get("stage") in STAGES
                and type(item.get("atMs")) is int and 0 <= item["atMs"] <= 10**9):
            stages.append({"stage": item["stage"], "atMs": item["atMs"]})
    result["stages"] = stages
    # cgroup counters are shared by the guest supervisor and its child. They
    # are deliberately labelled, and are not evidence of child-only pressure.
    group = value.get("cgroup")
    if isinstance(group, dict):
        counters = {key: group[key] for key in ("cpuUsageDeltaUsec", "memoryPeakBytes", "oomDelta", "oomKillDelta")
                    if type(group.get(key)) is int and 0 <= group[key] <= 10**15}
        if counters:
            result["cgroup"] = {"scope": "runner-cgroup", **counters}
    return result
