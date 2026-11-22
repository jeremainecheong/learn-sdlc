"""Finite fresh MicroVM jobs and one immutable MicroVM generation per preview."""
import base64
import bisect
from dataclasses import dataclass
import hashlib
import json
import math
import os
import random
import re
import threading
import time

from cloud import PREVIEW_REGION, PROTOCOL, Unavailable, CloudError, GuestError, encode, endpoint_host
from registry import Full, DuplicateTrace
from operation_trace import safe_diagnostics, valid_owner_id

MAX_BODY = 16 * 1024 * 1024
# The most finite-job MicroVMs one controller may hold at once (running or
# waiting on confirmed teardown). Config.job_limit (default 24) is the
# configured value below this bound of 32; previews are bounded the same way
# by PREVIEW_LIMIT_BOUND (Config.preview_limit, default 10). Both bounds are
# code constants, never environment keys: the host's environment file keeps
# its five keys. The installed values must stay under the account's MicroVM
# quota and the host's measured memory ceiling; the operator that installs
# the controller checks both.
JOB_LIMIT_BOUND = 32
PREVIEW_LIMIT_BOUND = 12
# RunMicrovm is rate limited per account (the RunMicrovm quota) and the CLI runs with
# AWS_MAX_ATTEMPTS=1, so the controller owns the retry of a throttled launch. It re-sends the same parameters
# (the same clientToken, so never a second VM) after a jittered backoff of LAUNCH_BACKOFF_BASE doubling up to
# LAUNCH_BACKOFF_CAP seconds; no re-send starts more than LAUNCH_RETRY_WINDOW seconds after the first send or
# inside the last LAUNCH_READY_RESERVE seconds of the run's boot budget, and at most LAUNCH_MAX_SENDS are sent.
# Each send keeps the CLI's own 20 s bound. A teardown's same-token replay never sleeps (it holds a claim): a
# throttled replay is a refused request, so it neither spends the one replay nor extends the row's life, and the
# reaper's next sweep repeats it.
LAUNCH_BACKOFF_BASE = 0.25
LAUNCH_BACKOFF_CAP = 1.0
LAUNCH_RETRY_WINDOW = 20
LAUNCH_MAX_SENDS = 16
LAUNCH_READY_RESERVE = 10
# Every RunMicrovm send first takes a token from one LaunchPacer: a token bucket at Config.launch_rate a second
# with Config.launch_burst tokens (code defaults 5.0 and 5, kept under the account's RunMicrovm quota; no
# environment key), served in admission order. A launch whose paced wait would end inside the last LAUNCH_READY_RESERVE seconds of its boot
# budget is refused at once by name (launch_pacing_budget), so the budget is never silently spent on waiting. A
# throttle the provider still returns goes through the re-send above, and each re-send takes a token in the run's
# own place. A teardown's replay waits its turn too, for at most LAUNCH_RETRY_WINDOW seconds and the row's life,
# and before it claims a cleanup slot, so no claim is held while it waits; a token it then cannot use goes back.
# The bucket refills at LAUNCH_RATE_MARGIN of the configured rate. AWS counts a request when it arrives, after the
# CLI's own start-up, so two grants exactly 1/rate apart could arrive closer than that and be throttled; a margin
# below 1 would leave room for that spread. The margin is 1.0, so the pacer runs at the configured rate: on the host
# each CLI send takes 1 to 4 s, which spaces the next one, and measured launches drew no throttle at 0.8 or at 1.0,
# while 1.0 launched sooner. Config.launch_rate is the rate health names and the operator checks against the account
# quota; the margin is a code constant, never configured.
LAUNCH_RATE_MARGIN = 1.0
LAUNCH_RATE_BOUNDS = (0.2, 50)
LAUNCH_BURST_BOUND = 50
PACER_POLL = 0.25  # a waiter re-checks its cancellation at least this often; a stop or a grant wakes it at once


class PacingLate(Exception):
    """The pacer cannot grant the token by the caller's latest instant."""


class Refusal(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)


@dataclass(frozen=True)
class Config:
    region: str
    image: str
    version: str
    ingress: str
    egress: str
    preview_limit: int = 10
    job_limit: int = 24
    preview_life: int = 600
    job_life: int = 180
    boot_seconds: int = 60
    # How many confirmed teardowns may run at once, from 1 to job_limit. The
    # default of 24 lets every job slot's teardown run at once; 1 runs one
    # cleanup at a time and leaves any other to the reaper's next sweep. A
    # code default like job_limit, never an environment key.
    cleanup_limit: int = 24
    # RunMicrovm's account quota as the pacer applies it: launches a second (default 5.0), and the bucket's burst
    # (default 5). Code defaults that must stay under the account's RunMicrovm quota, never environment keys.
    launch_rate: float = 5.0
    launch_burst: int = 5

    def __post_init__(self):
        if self.region != PREVIEW_REGION:
            raise ValueError("the preview deployment requires " + PREVIEW_REGION)
        prefix = r"arn:aws:lambda:" + re.escape(self.region) + r":([0-9]{12}):"
        image = re.fullmatch(prefix + r"microvm-image:[A-Za-z0-9_:/.-]+", self.image)
        egress = re.fullmatch(prefix + r"network-connector:[A-Za-z0-9_:/.-]+", self.egress)
        if not image or not egress or image.group(1) != egress.group(1):
            raise ValueError("pin same-account image and private egress connector ARNs")
        if not re.fullmatch(r"[^\s]{1,128}", self.version) or self.version.lower() in ("latest", "$latest"):
            raise ValueError("pin an explicit image version")
        if not re.fullmatch(r"arn:aws:lambda:" + re.escape(self.region) + r":aws:network-connector:aws-network-connector:[A-Z_]+", self.ingress):
            raise ValueError("explicit AWS-managed ingress connector required")
        if "SHELL" in self.ingress or "INTERNET" in self.egress:
            raise ValueError("shell ingress or internet egress is forbidden")
        if type(self.job_limit) is not int or not 1 <= self.job_limit <= JOB_LIMIT_BOUND:
            raise ValueError("job_limit must be a whole number from 1 to %d (the bounded preview policy)" % JOB_LIMIT_BOUND)
        if type(self.cleanup_limit) is not int or not 1 <= self.cleanup_limit <= self.job_limit:
            raise ValueError("cleanup_limit must be a whole number from 1 to the job limit (%d)" % self.job_limit)
        if (type(self.launch_rate) not in (int, float) or not math.isfinite(self.launch_rate)
                or not LAUNCH_RATE_BOUNDS[0] <= self.launch_rate <= LAUNCH_RATE_BOUNDS[1]):
            raise ValueError("launch_rate must be a number from %g to %g (launches a second)" % LAUNCH_RATE_BOUNDS)
        if type(self.launch_burst) is not int or not 1 <= self.launch_burst <= LAUNCH_BURST_BOUND:
            raise ValueError("launch_burst must be a whole number from 1 to %d" % LAUNCH_BURST_BOUND)
        if not (1 <= self.preview_limit <= PREVIEW_LIMIT_BOUND
                and 30 <= self.preview_life <= 600 and 60 <= self.job_life <= 300
                and 1 <= self.boot_seconds <= 60):
            raise ValueError("deployment limits exceed the bounded preview policy")

    @classmethod
    def from_env(cls):
        return cls(os.environ.get("AWS_REGION", PREVIEW_REGION),
                   os.environ["MICROVM_IMAGE_ARN"], os.environ["MICROVM_IMAGE_VERSION"],
                   os.environ["MICROVM_INGRESS_ARN"], os.environ["MICROVM_EGRESS_ARN"])


def initial_bytes(job, purpose):
    if not isinstance(job, dict) or job.get("mode") not in (("preview",) if purpose == "preview" else ("tests", "smoke")):
        raise Refusal(400, "invalid runner job mode")
    for key in ("files", "gradedFiles"):
        files = job.get(key, {})
        if not isinstance(files, dict) or len(files) > 1500:
            raise Refusal(400, "invalid source manifest")
        for path, text in files.items():
            if (not isinstance(path, str) or not path or "\\" in path or "\x00" in path
                    or path.startswith("/") or any(part in ("", ".", "..") for part in path.split("/"))
                    or not isinstance(text, str)):
                raise Refusal(400, "invalid source manifest")
    if purpose == "preview" and job.get("gradedFiles"):
        raise Refusal(400, "previews cannot receive grading files")
    try:
        raw = encode(job)
    except (ValueError, TypeError):
        raise Refusal(400, "invalid JSON job") from None
    if len(raw) > MAX_BODY:
        raise Refusal(413, "job too large")
    return raw


def finite_result(answer, mode):
    if (not isinstance(answer, dict) or type(answer.get("ok")) is not bool
            or answer.get("exitKind") not in ("ok", "error", "timeout", "memory", "unavailable")
            or any(not isinstance(answer.get(key, ""), str) or len(answer.get(key, "")) > 100000
                   for key in ("stdout", "stderr"))):
        raise Unavailable("invalid runner result")
    elapsed = answer.get("durationMs")
    if type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < 0:
        raise Unavailable("invalid runner duration")
    tests = answer.get("tests")
    if tests is not None:
        counts = ("total", "passed", "failed", "errored")
        if (not isinstance(tests, dict) or any(type(tests.get(k)) is not int or not 0 <= tests[k] <= 100000 for k in counts)
                or tests["total"] != sum(tests[k] for k in counts[1:])
                or not isinstance(tests.get("cases"), list) or len(tests["cases"]) != tests["total"]):
            raise Unavailable("invalid runner test totals")
        measured = {"passed": 0, "failed": 0, "errored": 0}
        for case in tests["cases"]:
            if not isinstance(case, dict) or case.get("status") not in measured or not isinstance(case.get("name"), str):
                raise Unavailable("invalid runner test case")
            measured[case["status"]] += 1
        if any(tests[key] != value for key, value in measured.items()):
            raise Unavailable("contradictory runner case totals")
        if answer["ok"] and (tests["failed"] or tests["errored"]):
            raise Unavailable("contradictory runner test result")
    if answer["ok"] and (answer["exitKind"] != "ok" or (mode == "tests" and (tests is None or tests["total"] <= 0))):
        raise Unavailable("contradictory runner result")
    # Explicit allowlist: never pass identity/control fields through to the API.
    return {key: answer[key] for key in ("ok", "exitKind", "stdout", "stderr", "durationMs", "tests") if key in answer}


def session_result(answer, public_id):
    if not isinstance(answer, dict) or answer.get("status") not in ("starting", "ready", "failed", "stopped", "busy", "unavailable"):
        raise Unavailable("invalid preview result")
    allowed = ("status", "message", "stopReason", "bundleOk", "startedAt", "readyAt", "expiresAt",
               "idleExpiresAt", "bytesServed", "console", "cursor")
    result = {key: answer[key] for key in allowed if key in answer}
    if "console" in result:
        if not isinstance(result["console"], list) or len(result["console"]) > 400:
            raise Unavailable("invalid preview console")
        for line in result["console"]:
            if not isinstance(line, dict) or not isinstance(line.get("text"), str) or len(line["text"]) > 2000:
                raise Unavailable("invalid preview console")
    result["id"] = public_id
    return result


class CleanupSlots:
    """The teardowns running now: at most `limit` at once, never two of one
    operation. A claim never waits. At limit 1 it succeeds only while no
    teardown runs, as the single non-blocking cleanup lock did before.
    `passes` counts the cleanup passes under way, claimed or not yet (a
    replay waiting for its launch token holds no claim)."""

    def __init__(self, limit):
        self.limit = limit
        self.guard = threading.Lock()
        self.running = set()
        self.passes = 0

    def claim(self, operation):
        with self.guard:
            if len(self.running) >= self.limit or operation in self.running:
                return False
            self.running.add(operation)
            return True

    def release(self, operation):
        with self.guard:
            self.running.discard(operation)

    def enter(self):
        with self.guard:
            self.passes += 1

    def leave(self):
        with self.guard:
            self.passes -= 1

    def busy(self):
        """A teardown pass is under way: a claim is held, or a pass has not reached its claim yet."""
        with self.guard:
            return bool(self.running) or self.passes > 0


class LaunchPacer:
    """One token bucket in front of every RunMicrovm send, served in ticket order. A ticket is drawn at admission
    (under active_lock, so tickets follow the admission order). Among the waiters that have arrived, a token goes
    to the earliest ticket, or to a later one only while the bucket holds a token for each ticket ahead of it too,
    so no later ticket passes an earlier one; a re-send keeps its run's ticket, so its place too. The guard is a leaf lock, as CleanupSlots.guard: no registry, cloud or active_lock call is made
    under it, and a waiter holds nothing else while it waits."""

    def __init__(self, rate, burst):
        self.rate, self.burst = float(rate), burst
        self.changed = threading.Condition(threading.Lock())
        self.tokens, self.stamp = float(burst), time.monotonic()
        self.queue, self.drawn = [], 0
        self.paced, self.paced_seconds = 0, 0.0

    def ticket(self):
        with self.changed:
            self.drawn += 1
            return self.drawn

    def take(self, ticket, latest=None, cancelled=None):
        """Wait for a token in ticket order and return the seconds waited (0.0 when none was needed). Raises
        PacingLate, before waiting past it, when the token cannot come by `latest`; a grant that needs no wait is
        never refused. `cancelled` is checked outside the guard at every wake. A take counts nothing on health:
        the bridge counts each launch that waited, once (count)."""
        began, waited = time.monotonic(), False
        with self.changed:
            if ticket not in self.queue: bisect.insort(self.queue, ticket)
        try:
            while True:
                if cancelled is not None and cancelled():
                    raise Unavailable("operation cancelled", code="operation_cancelled")
                with self.changed:
                    now = time.monotonic()
                    self.tokens = min(self.burst, self.tokens + max(0.0, now - self.stamp) * self.rate)
                    self.stamp = now
                    ahead = bisect.bisect_left(self.queue, ticket)
                    # The head takes the next token; a later ticket takes one only while one is left for every
                    # ticket ahead of it as well, so it never delays an earlier one.
                    if self.tokens >= ahead + 1 - 1e-9:
                        if waited and latest is not None and now > latest: raise PacingLate()
                        self.tokens -= 1
                        self.queue.remove(ticket)
                        self.changed.notify_all()
                        return now - began if waited else 0.0
                    # Every waiter ahead takes one token: the projected grant, refused now if it is too late.
                    need = max(0.0, (ahead + 1 - self.tokens) / self.rate)
                    if latest is not None and now + need > latest: raise PacingLate()
                    waited = True
                    self.changed.wait(min(PACER_POLL, need) if ahead == 0 else PACER_POLL)
        except BaseException:
            self.leave(ticket)
            raise

    def leave(self, ticket):
        with self.changed:
            if ticket in self.queue: self.queue.remove(ticket)
            self.changed.notify_all()

    def wake(self):
        """A stop: every waiter re-checks its cancellation now."""
        with self.changed:
            self.changed.notify_all()

    def refund(self):
        """A granted token that was not used to send (a teardown's replay that could not claim, or was no longer
        needed): back into the bucket, never beyond the burst, and the head re-checks now."""
        with self.changed:
            now = time.monotonic()
            self.tokens = min(self.burst, self.tokens + max(0.0, now - self.stamp) * self.rate + 1)
            self.stamp = now
            self.changed.notify_all()

    def count(self, seconds):
        """One launch that waited for its token(s), and its total wait, on health's totals."""
        with self.changed:
            self.paced += 1
            self.paced_seconds += seconds

    def totals(self):
        with self.changed:
            return self.paced, int(round(self.paced_seconds * 1000))


class Bridge:
    def __init__(self, config, registry, cloud, guest):
        self.config, self.registry, self.cloud, self.guest = config, registry, cloud, guest
        self.active = set()
        self.active_lock = threading.RLock()
        self.capacity_changed = threading.Condition(self.active_lock)
        self.admission_waiters = 0
        self.cleanup_slots = CleanupSlots(config.cleanup_limit)
        self.closing = False
        self.launch_throttles = 0  # throttled RunMicrovm answers since start, on health
        self.pacer = LaunchPacer(config.launch_rate * LAUNCH_RATE_MARGIN, config.launch_burst)
        self.launch_tickets = {}  # operation -> its pacer ticket, drawn at admission, until its launch takes it

    def parameters(self, purpose, source_hash, operation, secret):
        hook = {"protocol": PROTOCOL, "instanceId": operation, "controlToken": secret,
                "purpose": purpose, "sourceHash": source_hash}
        return {"imageIdentifier": self.config.image, "imageVersion": self.config.version,
                "ingressNetworkConnectors": [self.config.ingress],
                "egressNetworkConnectors": [self.config.egress], "logging": {"disabled": {}},
                # Explicitly prevent idle suspension during this short-lived
                # pilot: idle threshold exceeds every allowed VM lifetime.
                "idlePolicy": {"maxIdleDurationSeconds": 28800, "suspendedDurationSeconds": 0, "autoResumeEnabled": False},
                "maximumDurationInSeconds": self.config.job_life if purpose == "job" else self.config.preview_life,
                "runHookPayload": encode(hook).decode(), "clientToken": operation}

    def _admit(self, purpose, raw, deadline=None, trace=None):
        # A finished job still occupies its VM slot until teardown is confirmed.
        # Wait within the caller's existing boot budget for that cleanup. Cloud
        # teardown can take longer than ten seconds; this must not add a second
        # budget, reserve/launch a replacement early, or hide active load.
        until = deadline
        rechecked = False
        with self.capacity_changed:
            while True:
                if self.closing: raise Refusal(503, "runner stopping")
                if until is not None and time.monotonic() >= until:
                    raise Refusal(503, "runner capacity is full")
                digest = hashlib.sha256(raw).hexdigest()
                limit = self.config.job_limit if purpose == "job" else self.config.preview_limit
                try:
                    row = self.registry.create(purpose, digest, limit,
                           lambda operation, secret: self.parameters(purpose, digest, operation, secret), trace=trace)
                except DuplicateTrace:
                    raise Refusal(409, "platform attempt already recorded; no new execution started") from None
                except Full:
                    cleaning = any(row["purpose"] == purpose and row["cleanup"] and row["id"] not in self.active
                                   for row in self.registry.active())
                    remaining = until - time.monotonic() if until is not None else 0
                    if not cleaning and not rechecked:
                        # A teardown confirmed between Full and this read freed a slot: count once more,
                        # still under the lock, before refusing. One re-check, never a loop or a wait.
                        rechecked = True
                        continue
                    if not cleaning or remaining <= 0:
                        raise Refusal(503, "runner capacity is full") from None
                    # Releases active_lock while waiting: workers/reaper must be
                    # able to finish. Every wake rechecks atomic registry limits.
                    self.admission_waiters += 1
                    try:
                        self.capacity_changed.wait(timeout=remaining)
                    finally:
                        self.admission_waiters -= 1
                    continue
                self.active.add(row["id"])
                self.launch_tickets[row["id"]] = self.pacer.ticket()
                return row

    def _released(self, operation):
        with self.capacity_changed:
            self.active.discard(operation)
            self.launch_tickets.pop(operation, None)
            self.capacity_changed.notify_all()

    def _remember_vm(self, row, answer):
        vm_id = answer.get("microvmId") if isinstance(answer, dict) else None
        if not isinstance(vm_id, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,256}", vm_id):
            raise Unavailable("invalid cloud instance response")
        # Save the launched ID before validation so even a mismatched policy is
        # scheduled for cleanup rather than becoming an unknown resource.
        row = self.registry.update(row["id"], vm_id=vm_id)
        if (answer.get("imageArn") != self.config.image or answer.get("imageVersion") != self.config.version
                or answer.get("executionRoleArn")
                or answer.get("egressNetworkConnectors") != [self.config.egress]
                or answer.get("ingressNetworkConnectors") != [self.config.ingress]):
            raise Unavailable("cloud instance policy mismatch")
        endpoint_host(answer.get("endpoint"), self.config.region)
        return self.registry.update(row["id"], endpoint=answer["endpoint"])

    def _launch(self, row, deadline=None, granted=None):
        """`granted` is the seconds a teardown's replay already waited for the token it holds (taken before its
        cleanup claim, in cleanup_one); every other launch takes its token here."""
        parameters = json.loads(row["launch_json"])
        before = (row["launch_attempts"], row["expires"])
        operation = row["id"]
        ticket = None
        if granted is None:
            with self.active_lock:
                ticket = self.launch_tickets.pop(operation, None)
            if ticket is None: ticket = self.pacer.ticket()  # a launch admitted elsewhere arrives now, behind every waiter
        if deadline is None:
            latest, cancelled = self._replay_latest(row), lambda: self.closing
        else:
            latest = deadline - LAUNCH_READY_RESERVE
            cancelled = lambda: self.closing or self.registry.get(operation)["cleanup"]
        paced = granted or 0.0
        try:
            if granted is None:
                try:
                    paced += self.pacer.take(ticket, latest, cancelled)
                except PacingLate:
                    raise Unavailable("the paced launch would pass the boot budget", code="launch_pacing_budget") from None
            # Persist before sending. A crash can repeat only this same clientToken
            # with these same parameters, never a fresh blind create.
            row = self.registry.update(row["id"], launch_attempts=row["launch_attempts"] + 1,
                                       expires=time.time() + parameters["maximumDurationInSeconds"] + 60)
            first, sends = time.monotonic(), 0
            while True:
                sends += 1
                try:
                    answer = self.cloud.launch(parameters)
                except CloudError as error:
                    if error.code != "cloud_throttled": raise
                    with self.active_lock: self.launch_throttles += 1
                    if deadline is None:
                        # A teardown's replay: the provider refused it, so it is not spent and the life is not renewed.
                        self.registry.update(row["id"], launch_attempts=before[0], expires=before[1])
                        raise
                    # A throttle is a refused request, not an unknown launch: launch_attempts stays as it is, and the
                    # row records the throttle (the run's last error unless a later stage fails).
                    self._diagnostic(row["id"], "launch", error)
                    step = min(LAUNCH_BACKOFF_CAP, LAUNCH_BACKOFF_BASE * 2 ** (sends - 1))
                    delay = step / 2 + random.random() * step / 2
                    resend = time.monotonic() + delay
                    if (sends >= LAUNCH_MAX_SENDS or resend - first > LAUNCH_RETRY_WINDOW
                            or resend > deadline - LAUNCH_READY_RESERVE or self.closing):
                        raise
                    time.sleep(delay)
                    if self.closing or self.registry.get(row["id"])["cleanup"]: raise
                    # The re-send takes a token too, in the run's own place, inside the same bounds.
                    try:
                        paced += self.pacer.take(ticket, min(deadline - LAUNCH_READY_RESERVE, first + LAUNCH_RETRY_WINDOW),
                                                 cancelled)
                    except PacingLate:
                        raise error from None
                    continue
                return self._remember_vm(row, answer)
        finally:
            if ticket is not None: self.pacer.leave(ticket)
            # Health counts this launch once if any of its granted tokens was waited for; no row carries the wait.
            if paced > 0: self.pacer.count(paced)

    @staticmethod
    def _replay_latest(row):
        """A teardown's replay waits for its token at most the re-send window and the row's remaining life."""
        return time.monotonic() + max(0.0, min(LAUNCH_RETRY_WINDOW, row["expires"] - time.time()))

    def _needs_replay(self, row):
        """The row's teardown owes its one same-token launch replay: an unknown launch answer, no VM id, life left."""
        if (not row or not row["cleanup"] or row["state"] in ("terminated", "expired-unconfirmed") or row["vm_id"]
                or row["launch_attempts"] != 1 or time.time() >= row["expires"]):
            return False
        with self.active_lock:
            return row["id"] not in self.active

    def _replay_token(self, operation):
        """A replay's token is taken before its cleanup claim, so no claim is held while it waits.
        Returns the seconds waited for a granted token, "late" when the pacer cannot serve it inside the window,
        or None (no replay is owed, or a stop ended the wait: the next pass takes it again). A replay that starts
        waiting before a shutdown sees the shutdown at once; shutdown's own sweep still gives the row its replay."""
        row = self.registry.get(operation)
        if not self._needs_replay(row): return None
        stopping = self.closing
        try:
            return self.pacer.take(self.pacer.ticket(), self._replay_latest(row),
                                   lambda: self.closing and not stopping)
        except PacingLate:
            return "late"
        except Unavailable:
            return None

    def _ready(self, row, deadline=None):
        deadline = deadline or time.monotonic() + self.config.boot_seconds
        while time.monotonic() < deadline:
            current = self.registry.get(row["id"])
            if current["cleanup"] or self.closing: raise Unavailable("operation cancelled")
            try:
                # The poll keeps the whole remaining boot budget. The VM's proxy-token mint runs under cloud.py's one
                # process-wide guest lock inside this same timeout, so with VMs booting together a shorter poll would
                # spend its time queued and the mint would be killed (cloud_timeout) before it could finish.
                answer = self.guest.request(row, "/health", timeout=max(.001, deadline-time.monotonic()))
                if answer.get("ok") is True and answer.get("purpose") == row["purpose"]:
                    return row
            except (Unavailable, GuestError) as error:
                self._diagnostic(row["id"], "readiness", error)
            time.sleep(min(0.5, max(0, deadline-time.monotonic())))
        raise Unavailable("remote runtime did not become ready", code="runtime_not_ready")

    def _diagnostic(self, operation, stage, error):
        # Never serialize exception prose: it can contain request data or keys.
        code = error.code if isinstance(error, (Unavailable, GuestError)) else "internal_error"
        if stage == "cleanup":
            self.registry.update(operation, cleanup_error_code=code, cleanup_error_at=time.time())
        else:
            self.registry.update(operation, last_error_code=code, last_error_stage=stage,
                                 last_error_at=time.time())
        error.operation_id, error.stage = operation, stage

    def _initial_request(self, row, route, raw, deadline, per_attempt):
        """Recover one lost response from the same guest's cached initial result.

        The immutable guest validates exact source bytes and owns an at-most-once
        /execute or /app/start latch, including cached failures. Never replay app
        proxy mutations, mint a new VM, alter bytes or renew the caller deadline.
        """
        for attempt in range(2):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise Unavailable("remote request deadline exceeded", code="guest_deadline")
            if self.registry.get(row["id"])["cleanup"] or self.closing:
                raise Unavailable("operation cancelled", code="operation_cancelled")
            self.registry.update(row["id"], initial_attempts=attempt + 1)
            try:
                return self.guest.request(row, route, raw, timeout=min(per_attempt, remaining))
            except (Unavailable, GuestError) as error:
                self._diagnostic(row["id"], "initial-request", error)
                # Bound guest errors, invalid identity/results and expired
                # budgets are final. Only transport/proxy failures reconcile.
                if attempt or not error.retryable or deadline - time.monotonic() <= .25:
                    raise
                time.sleep(.25)

    def execute(self, job, trace=None):
        raw = initial_bytes(job, "job")
        seconds = job.get("timeoutSeconds", 15)
        if type(seconds) not in (int, float) or not math.isfinite(seconds) or not 1 <= seconds <= 60:
            raise Refusal(400, "execution timeout must be between 1 and 60 seconds")
        started = time.monotonic()
        deadline = started + self.config.boot_seconds + seconds + 10
        row = self._admit("job", raw, deadline=min(deadline, started + self.config.boot_seconds), trace=trace)
        stage = "launch"
        try:
            row = self._launch(row, started + self.config.boot_seconds)
            stage = "readiness"
            row = self._ready(row, started + self.config.boot_seconds)
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise Unavailable("finite operation deadline exceeded")
            stage = "initial-request"
            answer = self._initial_request(row, "/execute", raw, deadline, seconds + 20)
            if time.monotonic() >= deadline: raise Unavailable("finite operation deadline exceeded")
            stage = "validate-result"
            diagnostics = safe_diagnostics(answer.get("diagnostics")) if isinstance(answer, dict) else None
            if diagnostics is not None:
                self.registry.update(row["id"], diagnostics_json=json.dumps(diagnostics, separators=(",", ":")))
            answer = finite_result(answer, job["mode"])
            # Never write/return a guest result after an administrative stop.
            if self.registry.get(row["id"])["cleanup"] or self.closing:
                raise Unavailable("operation cancelled")
            self.registry.update(row["id"], result_ok=int(answer["ok"]))
            return answer
        except Exception as error:
            self._diagnostic(row["id"], stage, error)
            raise
        finally:
            self.registry.update(row["id"], cleanup=1, state="cleanup")
            self._released(row["id"])
            # Teardown is durable but must not extend the caller's deadline.
            threading.Thread(target=self.cleanup_one, args=(row["id"],), daemon=True).start()

    def start(self, job, trace=None):
        raw = initial_bytes(job, "preview")
        row = self._admit("preview", raw, trace=trace)
        thread = threading.Thread(target=self._start_worker, args=(row, raw), daemon=True)
        try:
            thread.start()
        except BaseException:
            self.registry.update(row["id"], cleanup=1, state="cleanup")
            self._released(row["id"])
            raise
        return self._local_view(row)

    def _start_worker(self, row, raw):
        stage = "launch"
        try:
            ready_deadline = time.monotonic() + self.config.boot_seconds
            row = self._launch(row, ready_deadline)
            stage = "readiness"
            row = self._ready(row, ready_deadline)
            stage = "initial-request"
            answer = self._initial_request(row, "/app/start", raw, time.monotonic() + 70, 70)
            stage = "validate-result"
            view = session_result(answer, row["id"])
            guest_id = answer.get("id")
            if not isinstance(guest_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", guest_id):
                raise Unavailable("invalid preview identity")
            with self.active_lock:
                if self.registry.get(row["id"])["cleanup"] or self.closing or time.time() >= row["expires"]:
                    raise Unavailable("operation cancelled")
                self.registry.update(row["id"], guest_id=guest_id, state="running",
                    cleanup=int(view["status"] not in ("starting", "ready")),
                    failure=None if view["status"] in ("starting", "ready") else "preview failed to start")
        except Exception as error:
            self._diagnostic(row["id"], stage, error)
            self.registry.update(row["id"], cleanup=1, state="cleanup", failure="The remote preview could not start. Your saved files are unchanged; start it again.")
        finally:
            self._released(row["id"])
            if self.registry.get(row["id"])["cleanup"]:
                self.cleanup_one(row["id"])

    def _local_view(self, row):
        status = "failed" if row["failure"] else "stopped" if row["cleanup"] or row["state"] in ("terminated", "expired-unconfirmed") else "starting"
        result = {"id": row["id"], "status": status, "message": row["failure"], "console": [], "cursor": 0,
                  "cleanupConfirmed": self._cleanup_confirmed(row)}
        if row["failure"]: result["bundleOk"] = False
        return result

    @staticmethod
    def _cleanup_confirmed(row):
        return (row["state"] == "terminated" and row["cleanup_outcome"] in
                ("provider-terminated", "absent-after-expiry", "not-launched"))

    def lookup_owner(self, job):
        if (set(job) != {"kind", "ownerId"} or job.get("kind") != "preview"
                or not valid_owner_id(job.get("ownerId"))):
            raise Refusal(400, "invalid preview owner lookup")
        rows = self.registry.owner_operations("preview", job["ownerId"])
        if len(rows) > 1:
            raise Refusal(409, "preview owner has ambiguous operations")
        if not rows:
            # Absence is not a tombstone: a paused API request may still arrive.
            return {"found": False, "cleanupConfirmed": False}
        return {"found": True, "runnerId": rows[0]["id"],
                "cleanupConfirmed": self._cleanup_confirmed(rows[0])}

    def app(self, route, job):
        operation = job.get("id")
        if not isinstance(operation, str): raise Refusal(404, "no such preview")
        row = self.registry.get(operation)
        if not row or row["purpose"] != "preview": raise Refusal(404, "no such preview")
        if route == "stop":
            with self.active_lock:
                row = self.registry.update(operation, cleanup=1)
            self.pacer.wake()  # a start still waiting for its launch token sees the stop now
            self.cleanup_one(operation)
            return self._local_view(self.registry.get(operation))
        if row["cleanup"] or row["state"] != "running":
            if route == "status": return self._local_view(row)
            raise Refusal(409, "the app is not running")
        if time.time() >= row["expires"]:
            self.registry.update(operation, cleanup=1)
            raise Refusal(409, "the preview has expired")
        forwarded = {"id": row["guest_id"]}
        if route == "status":
            cursor = job.get("cursor", 0)
            if type(cursor) is not int or not 0 <= cursor <= 10**12: raise Refusal(400, "invalid console cursor")
            forwarded["cursor"] = cursor
        elif route in ("proxy", "asset"):
            path = job.get("path", "")
            if not isinstance(path, str) or len(path) > 8192 or any(ord(c) < 32 for c in path):
                raise Refusal(400, "invalid preview path")
            forwarded["path"] = path
            if route == "proxy":
                if job.get("method") not in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
                    raise Refusal(400, "invalid preview method")
                if not (path == "/api" or path.startswith("/api/") or path.startswith("/api?")):
                    raise Refusal(400, "invalid preview API path")
                headers = job.get("headers", {})
                if not isinstance(headers, dict): raise Refusal(400, "invalid preview headers")
                forwarded.update(method=job["method"], headers={k.lower(): v for k, v in headers.items()
                    if k.lower() in ("content-type", "accept") and isinstance(v, str) and len(v) < 4096 and "\r" not in v and "\n" not in v})
                body = job.get("body", "")
                if not isinstance(body, str): raise Refusal(400, "invalid preview body")
                try: base64.b64decode(body, validate=True)
                except ValueError: raise Refusal(400, "invalid preview body") from None
                forwarded["body"] = body
        else:
            raise Refusal(404, "unknown runner route")
        answer = self.guest.request(row, "/app/" + route, encode(forwarded), timeout=25)
        if self.registry.get(operation)["cleanup"]: raise Refusal(409, "the app is not running")
        self.registry.update(operation, last_seen=time.time())
        if route == "status":
            view = session_result(answer, operation)
            if view["status"] in ("stopped", "failed"):
                self.registry.update(operation, cleanup=1)
            view["cleanupConfirmed"] = self._cleanup_confirmed(self.registry.get(operation))
            return view
        if not isinstance(answer, dict) or type(answer.get("status")) is not int or not 100 <= answer["status"] <= 599:
            raise Unavailable("invalid preview response")
        try:
            body = answer.get("body", "")
            if not isinstance(body, str): raise ValueError()
            base64.b64decode(body, validate=True)
        except ValueError:
            raise Unavailable("invalid preview response bytes") from None
        result = {"status": answer["status"], "body": body}
        if route == "asset":
            kind = answer.get("contentType", "application/octet-stream")
            if not isinstance(kind, str) or len(kind) > 256 or "\r" in kind or "\n" in kind:
                raise Unavailable("invalid preview response type")
            result["contentType"] = kind
        else:
            headers = answer.get("headers", {})
            if not isinstance(headers, dict): raise Unavailable("invalid preview response headers")
            result["headers"] = {k.lower(): v for k, v in headers.items() if k.lower() == "content-type"
                and isinstance(v, str) and len(v) <= 256 and "\r" not in v and "\n" not in v}
            result["truncated"] = answer.get("truncated") is True
        return result

    def cleanup_one(self, operation):
        self.cleanup_slots.enter()
        try:
            self._cleanup_pass(operation)
        finally:
            self.cleanup_slots.leave()

    def _cleanup_pass(self, operation):
        # At most config.cleanup_limit cleanup passes at once and never two of
        # one operation (at a limit of 1, one reaper/cloud-cleanup pass at a
        # time). A pass that finds no free claim returns at once: the intent is
        # durable and the reaper's next sweep retries it. Active starts are
        # cancelled by their worker so stop cannot launch an instance it is
        # racing with. The slot stays counted until teardown is confirmed.
        # A replay's launch token is taken first, with no claim held,
        # and refunded in the finally below unless the replay is sent.
        token = self._replay_token(operation)
        if not self.cleanup_slots.claim(operation):
            if type(token) is float: self.pacer.refund()
            return
        try:
            with self.active_lock:
                if operation in self.active: return
            row = self.registry.get(operation)
            if not row or row["state"] in ("terminated", "expired-unconfirmed") or not row["cleanup"]: return
            row = self.registry.update(operation, cleanup_attempts=row["cleanup_attempts"] + 1)
            if not row["vm_id"]:
                if row["launch_attempts"] == 0:
                    self.registry.update(operation, state="terminated", cleanup_outcome="not-launched")
                    return
                if row["launch_attempts"] < 2 and time.time() < row["expires"]:
                    # One bounded same-token launch replay resolves an unknown
                    # response; it never runs learner code, only terminates it.
                    if token == "late":
                        # Not sent, so not spent: the next sweep repeats it.
                        raise Unavailable("the paced replay would pass its window", code="launch_pacing_budget")
                    if type(token) is not float:
                        return  # it came to need its replay after the check: the next pass takes its token first
                    granted, token = token, None
                    row = self._launch(row, granted=granted)
                elif time.time() >= row["expires"]:
                    self.registry.update(operation, state="expired-unconfirmed", cleanup_outcome="expired-unconfirmed")
                    return
                else:
                    return
            answer = self.cloud.get(row["vm_id"])
            if answer.get("microvmId") != row["vm_id"]:
                raise Unavailable("cleanup identity mismatch")
            self.registry.update(operation, missing_since=None, missing_count=0)
            if answer.get("state") == "TERMINATED":
                self.registry.update(operation, state="terminated", cleanup_outcome="provider-terminated")
                self.guest.forget(row["vm_id"])
                return
            self.cloud.terminate(row["vm_id"])
            # Accepted terminate is not confirmation of completed teardown.
            self.registry.update(operation, state="cleanup")
            answer = self.cloud.get(row["vm_id"])
            if answer.get("microvmId") == row["vm_id"] and answer.get("state") == "TERMINATED":
                self.registry.update(operation, state="terminated", cleanup_outcome="provider-terminated")
                self.guest.forget(row["vm_id"])
        except CloudError as error:
            self._diagnostic(operation, "cleanup", error)
            # Get is eventually consistent. Never release a newly created VM
            # on a single 404, an image lookup failure, denied permission, a
            # mismatched resource or a generic transport error. After the
            # recorded maximum lifetime + grace, require two exact-ID Get 404s
            # at least one reaper interval apart. Durable intent survives restarts.
            row = self.registry.get(operation)
            if (error.code == "cloud_not_found" and error.operation == "get-microvm"
                    and row["vm_id"] and error.resource_id == row["vm_id"]
                    and time.time() >= row["expires"]):
                now = time.time()
                since = row["missing_since"] if row["missing_since"] is not None else now
                count = row["missing_count"] + 1
                self.registry.update(operation, missing_since=since, missing_count=count)
                if count >= 2 and now - since >= 5:
                    self.registry.update(operation, state="terminated", cleanup_outcome="absent-after-expiry")
                    self.guest.forget(row["vm_id"])
            else:
                self.registry.update(operation, missing_since=None, missing_count=0)
            return
        except Exception as error:
            self._diagnostic(operation, "cleanup", error)
            self.registry.update(operation, missing_since=None, missing_count=0)
            # Intent is durable. Next sweep tries again; no raw CLI/guest data.
            return
        finally:
            if type(token) is float: self.pacer.refund()  # granted but not sent: the claimed row no longer needed it
            self.cleanup_slots.release(operation)
            with self.capacity_changed:
                self.capacity_changed.notify_all()

    def close_expired(self, job):
        """Close an expired-unconfirmed row by name, on the controller's proof: the row is past its recorded life
        and one complete, read-only inventory of the row's own image and version shows no MicroVM that is not
        TERMINATED and not a registered row's own. The life is the row's expiry plus the VM's maximum duration:
        every send happens before the expiry, and a throttled replay puts the expiry back, so a VM that such a send
        did start ends by then. Never adopts, terminates or deletes a VM; it only records the absence
        (absent-after-expiry)."""
        if set(job) != {"id"} or not isinstance(job.get("id"), str) or not re.fullmatch(
                r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", job["id"]):
            raise Refusal(400, "invalid operation close")
        row = self.registry.get(job["id"])
        if not row: raise Refusal(404, "no such operation")
        try:
            launch = json.loads(row["launch_json"])
        except ValueError:
            launch = None
        if (not isinstance(launch, dict) or type(launch.get("maximumDurationInSeconds")) is not int
                or not isinstance(launch.get("imageIdentifier"), str) or not isinstance(launch.get("imageVersion"), str)):
            raise Refusal(409, "the operation's launch record is unreadable")
        if row["state"] != "expired-unconfirmed" or time.time() < row["expires"] + launch["maximumDurationInSeconds"]:
            raise Refusal(409, "the operation is not expired-unconfirmed")
        answer = self.cloud.inventory(launch["imageIdentifier"], launch["imageVersion"])
        items = answer.get("items") if isinstance(answer, dict) else None
        if not isinstance(items, list) or answer.get("nextToken"):
            raise Refusal(409, "the MicroVM inventory is incomplete")
        with self.registry.lock:
            known = {value for value in (r["vm_id"] for r in self.registry.active()) if value}
        if any(not isinstance(item, dict) or (item.get("state") != "TERMINATED" and item.get("microvmId") not in known)
               for item in items):
            raise Refusal(409, "an unregistered MicroVM of this image is still running")
        self.registry.update(row["id"], state="terminated", cleanup_outcome="absent-after-expiry")
        with self.capacity_changed:
            self.capacity_changed.notify_all()
        return {"closed": True, "cleanupConfirmed": self._cleanup_confirmed(self.registry.get(row["id"]))}

    def sweep(self, startup=False):
        pending = []
        for row in self.registry.active():
            with self.active_lock:
                if row["id"] in self.active: continue
            if startup and (row["purpose"] == "job" or row["state"] == "creating"):
                row = self.registry.update(row["id"], cleanup=1, failure="The remote operation was interrupted; retry from your saved work.")
            if time.time() >= row["expires"] or (row["purpose"] == "preview" and time.time() - row["last_seen"] > 300):
                row = self.registry.update(row["id"], cleanup=1)
            if row["cleanup"]:
                # At a limit of 1 each teardown runs here, in line, in turn.
                if self.config.cleanup_limit == 1: self.cleanup_one(row["id"])
                else: pending.append(row["id"])
        self._cleanup_together(pending)

    def _cleanup_together(self, operations):
        """Up to cleanup_limit of the sweep's teardowns at once. Returns only
        when each has had its pass, as the serial sweep does, so shutdown's
        sweep still finishes its teardowns before the process exits."""
        if not operations: return
        queue, guard = list(operations), threading.Lock()

        def worker():
            while True:
                with guard:
                    if not queue: return
                    operation = queue.pop(0)
                self.cleanup_one(operation)

        started = []
        try:
            for _ in range(min(self.config.cleanup_limit, len(queue))):
                thread = threading.Thread(target=worker, daemon=True)
                thread.start()
                started.append(thread)
        except RuntimeError:
            # A worker that cannot start (the unit's task limit): this thread drains the rest itself, so every
            # pending row still has its pass, never more than cleanup_limit at once, and the sweep never raises.
            worker()
        finally:
            for thread in started: thread.join()

    def health(self):
        counts = self.registry.stats()
        with self.active_lock:
            waiting, throttles = self.admission_waiters, self.launch_throttles
        paced, paced_ms = self.pacer.totals()
        return {"ok": not self.closing, "transport": "lambda-microvms", "protocol": PROTOCOL,
                "capabilities": {"ownerTrace": 1, "ownerLookup": 1, "cleanupConfirmation": 1, "runtimeDiagnostics": 1},
                "isolation": {"status": "ok", "mechanism": "single-job-microvm"},
                "slots": self.config.job_limit, "cleanupLimit": self.config.cleanup_limit,
                "inFlight": counts["job"],
                "previews": counts["preview"], "previewSlots": self.config.preview_limit,
                "expiredUnconfirmed": counts["expiredUnconfirmed"],
                "waiting": waiting, "launchThrottles": throttles,
                "launchRate": self.config.launch_rate, "launchBurst": self.config.launch_burst,
                "launchPaced": paced, "launchPacedMs": paced_ms,
                "readiness": "configured; not a billable runtime probe"}

    def shutdown(self):
        with self.capacity_changed:
            self.closing = True
            for row in self.registry.active(): self.registry.update(row["id"], cleanup=1)
            self.capacity_changed.notify_all()
        self.pacer.wake()  # every launch still waiting for a token stops now
        self.sweep()
