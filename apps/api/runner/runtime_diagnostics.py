"""Bounded supervisor telemetry. Never reads source, argv, env or child output."""
from contextvars import ContextVar
from pathlib import Path
import os
import threading
import time

CURRENT = ContextVar("runtime_diagnostics", default=None)
STAGES = {"prepare", "transform", "test-child", "smoke-child", "timeout", "cleanup", "complete", "unsupported"}


def stage(name):
    current = CURRENT.get()
    if current is not None and name in STAGES:
        current.stage(name)


def _read(path):
    try:
        with open(path, encoding="ascii") as handle:
            return handle.read(8192)
    except (OSError, UnicodeError):
        return ""


def process_sample(pid):
    """Linux counters for the exact child; missing data stays unknown."""
    if type(pid) is not int or pid <= 0:
        return {}
    try:
        # comm may contain spaces and parentheses; it is never returned.
        stat = _read(f"/proc/{pid}/stat").rsplit(")", 1)[1].split()
        ticks = os.sysconf("SC_CLK_TCK")
        result = {"cpuUserMs": int(int(stat[11]) * 1000 / ticks),
                  "cpuSystemMs": int(int(stat[12]) * 1000 / ticks)}
        for line in _read(f"/proc/{pid}/status").splitlines():
            if line.startswith("VmHWM:"):
                result["peakRssBytes"] = int(line.split()[1]) * 1024
        return {key: value for key, value in result.items() if 0 <= value <= 10**15}
    except (ValueError, IndexError, OSError):
        return {}


def cgroup_sample():
    """Read only a fixed set of cgroup-v2 counters for this runner's group."""
    entries = _read("/proc/self/cgroup").splitlines()
    path = next((line[3:] for line in entries if line.startswith("0::")), None)
    if not path or any(part == ".." for part in path.split("/")):
        return {}
    root = Path("/sys/fs/cgroup") / path.lstrip("/")
    values = {}
    for filename, keys in (("cpu.stat", {"usage_usec": "cpuUsageDeltaUsec"}),
                           ("memory.events", {"oom": "oomDelta", "oom_kill": "oomKillDelta"})):
        for line in _read(root / filename).splitlines():
            pair = line.split()
            if len(pair) == 2 and pair[0] in keys and pair[1].isdigit():
                values[keys[pair[0]]] = int(pair[1])
    peak = _read(root / "memory.peak").strip()
    if peak.isdigit(): values["memoryPeakBytes"] = int(peak)
    return {key: value for key, value in values.items() if value <= 10**15}


class Diagnostics:
    def __init__(self):
        self.started = time.monotonic()
        self.stages = []
        self.counters = {}
        self.samples = 0
        self.group_before = cgroup_sample()
        self.lock = threading.Lock()

    def stage(self, name):
        with self.lock:
            if len(self.stages) < 16:
                self.stages.append({"stage": name, "atMs": self.elapsed()})

    def elapsed(self):
        return max(0, min(10**9, int((time.monotonic() - self.started) * 1000)))

    def sample(self, pid):
        counters = process_sample(pid)
        with self.lock:
            self.samples += 1
            for key, value in counters.items():
                self.counters[key] = max(self.counters.get(key, 0), value)

    def result(self):
        group = cgroup_sample()
        deltas = {}
        for key, value in group.items():
            if key == "memoryPeakBytes": deltas[key] = value
            elif key in self.group_before:
                deltas[key] = max(0, value - self.group_before[key])
        with self.lock:
            return {"version": 1, "scope": "supervisor-observed-child", "wallMs": self.elapsed(),
                    "cpuScope": "maximum-observed-child",
                    "stages": list(self.stages), "samples": self.samples, **self.counters,
                    **({"cgroup": {"scope": "runner-cgroup", **deltas}} if deltas else {})}


class ChildSampler:
    def __init__(self, pid):
        self.diagnostics, self.pid = CURRENT.get(), pid
        self.stop = threading.Event()
        self.thread = None
        if self.diagnostics is not None:
            self.sample()
            self.thread = threading.Thread(target=self._sample, daemon=True)
            try:
                self.thread.start()
            except (OSError, RuntimeError):
                self.thread = None  # Resource telemetry never changes a verdict.

    def sample(self):
        if self.diagnostics is not None:
            self.diagnostics.sample(self.pid)

    def _sample(self):
        # Finite even if a transport/cleanup bug outlives the job's deadline.
        for _ in range(650):
            if self.stop.wait(.1): return
            self.sample()

    def close(self):
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=.2)
