"""The FIFO launch pacer. RunMicrovm is rate limited per account (code defaults 5.0 a second, burst 5), and a random
re-send backoff alone starves later-admitted runs when many launch together. Every launch send takes a token from one
bucket, in admission order, inside the boot budget.

The bucket refills at LAUNCH_RATE_MARGIN of the configured rate (1.0: measured launches drew no throttle at 0.8 or
at 1.0, and 1.0 launched sooner); the configured rate stays the applied quota and is what health names. A teardown's
replay takes its token before its cleanup claim and gives an unused one back; no row carries the paced wait (health
does, counting launches that waited); and every wait in these pins is bounded, so a pacer that never grants fails the
suite instead of hanging it."""
import json
from pathlib import Path
import random
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import bridge as module
from bridge import Bridge, Config
# Read by name so that, on a controller without the pacer, each pin fails on its own rather than the import.
LaunchPacer, PacingLate = getattr(module, "LaunchPacer", None), getattr(module, "PacingLate", AssertionError)
MARGIN = 1.0  # the pinned value of bridge.LAUNCH_RATE_MARGIN
from cloud import CloudError, Unavailable, encode
from operation_trace import safe_diagnostics
from registry import Registry
import test_bridge
from test_bridge import Cloud, Guest, IMAGE, EGRESS, INGRESS, JOB, PREVIEW, RESULT, RECORDED_SERIAL_SEQUENCE


def make(test, cloud=None, guest=None, **limits):
    """A bridge at the code's own Config (the pacer at its defaults unless a case names a rate)."""
    temp = tempfile.TemporaryDirectory()
    test.addCleanup(temp.cleanup)
    registry = Registry(Path(temp.name) / "private" / "registry.sqlite")
    test.addCleanup(registry.close)
    threads = threading.active_count()
    def settle():
        for _ in range(500):
            if threading.active_count() <= threads: return
            time.sleep(.01)
    test.addCleanup(settle)
    limits = {"job_limit": 2, "cleanup_limit": 1, "boot_seconds": 60, **limits}
    bridge = Bridge(Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, **limits), registry, cloud or Cloud(),
                    guest or Guest())
    return bridge, registry


def bounded(test, call, seconds=10.0):
    """Run a call that waits on the pacer in a daemon thread and fail, never hang, if it does not return in time."""
    box = {}
    def run():
        try: box["value"] = call()
        except BaseException as error: box["error"] = error
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(seconds)
    test.assertFalse(thread.is_alive(), "the call did not return within %g s (a pacer that never grants)" % seconds)
    if "error" in box: raise box["error"]
    return box.get("value")


def daemon(target, *args):
    thread = threading.Thread(target=target, args=args, daemon=True)
    thread.start()
    return thread


def joined(test, threads, seconds=10.0):
    end = time.monotonic() + seconds
    for thread in threads: thread.join(max(0.0, end - time.monotonic()))
    test.assertFalse(any(thread.is_alive() for thread in threads), "a waiter did not return within %g s" % seconds)


def wait_until(predicate, seconds=5.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate(): return True
        time.sleep(.002)
    return False


def unknown_launch(bridge, registry):
    """A row whose launch answer was unknown: its teardown owes it one same-token replay."""
    row = bridge._admit("job", encode(JOB))
    row = registry.update(row["id"], launch_attempts=1, cleanup=1, state="cleanup")
    bridge._released(row["id"])
    return row


class SendLog(Cloud):
    """The fake provider, recording each launch send's instant and clientToken."""

    def __init__(self, throttle_first=()):
        super().__init__()
        self.sends, self.guard, self.throttle_first = [], threading.Lock(), set(throttle_first)

    def launch(self, parameters):
        with self.guard:
            self.sends.append((time.monotonic(), parameters["clientToken"]))
            if parameters["clientToken"] in self.throttle_first:
                self.throttle_first.discard(parameters["clientToken"])
                raise CloudError("run-microvm", "ThrottlingException")
        return super().launch(parameters)

    def sent(self, token):
        return [at for at, sent in self.sends if sent == token]


class ConfigTests(unittest.TestCase):
    def test_the_defaults_are_five_a_second_burst_five(self):
        config = Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS)
        self.assertEqual((config.launch_rate, config.launch_burst), (5.0, 5))
        self.assertEqual(module.LAUNCH_RATE_BOUNDS, (0.2, 50))
        self.assertEqual(module.LAUNCH_BURST_BOUND, 50)

    def test_the_bounds_are_refused_by_name(self):
        for rate in (0.2, 1, 1.0, 2.5, 5, 50, 50.0):
            with self.subTest(rate=rate):
                self.assertEqual(Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, launch_rate=rate).launch_rate, rate)
        for rate in (0.19, 0, -1, 50.01, 51, float("inf"), float("nan"), True, "1", None):
            with self.subTest(rate=rate):
                with self.assertRaises(ValueError) as refused:
                    Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, launch_rate=rate)
                self.assertEqual(str(refused.exception), "launch_rate must be a number from 0.2 to 50 (launches a second)")
        for burst in (1, 2, 5, 50):
            with self.subTest(burst=burst):
                self.assertEqual(Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, launch_burst=burst).launch_burst, burst)
        for burst in (0, -1, 51, 1.0, True, "1", None):
            with self.subTest(burst=burst):
                with self.assertRaises(ValueError) as refused:
                    Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, launch_burst=burst)
                self.assertEqual(str(refused.exception), "launch_burst must be a whole number from 1 to 50")

    def test_no_environment_key_sets_the_pacing(self):
        five = {"AWS_REGION": "ap-southeast-1", "MICROVM_IMAGE_ARN": IMAGE, "MICROVM_IMAGE_VERSION": "1",
                "MICROVM_INGRESS_ARN": INGRESS, "MICROVM_EGRESS_ARN": EGRESS}
        read = set()
        class Recording(dict):
            def __getitem__(self, key): read.add(key); return dict.__getitem__(self, key)
            def get(self, key, default=None): read.add(key); return dict.get(self, key, default)
        # Inputs unequal to every code default (rate 5.0, burst 5, margin 1.0), so a read of any of them shows.
        environ = Recording(five, MICROVM_LAUNCH_RATE="7", LAUNCH_RATE="7", MICROVM_LAUNCH_BURST="3", LAUNCH_BURST="3",
                            LAUNCH_RATE_MARGIN="0.5", MICROVM_LAUNCH_RATE_MARGIN="0.5")
        _, registry = make(self)
        with patch.object(module.os, "environ", environ):
            config = module.Config.from_env()
            bridge = Bridge(config, registry, Cloud(), Guest())
        self.assertEqual(read, set(five))
        self.assertEqual((config.launch_rate, config.launch_burst), (5.0, 5))
        self.assertAlmostEqual(bridge.pacer.rate, 5.0 * MARGIN, places=9, msg="no environment key sets the margin either")

    def test_health_names_the_rate_and_burst_and_the_paced_totals(self):
        for limits, expected in (({}, (5.0, 5)), ({"launch_rate": 2.0, "launch_burst": 3}, (2.0, 3))):
            with self.subTest(limits=limits):
                bridge, _ = make(self, **limits)
                health = bridge.health()
                self.assertEqual((health["launchRate"], health["launchBurst"]), expected)
                self.assertEqual((health["launchPaced"], health["launchPacedMs"]), (0, 0))

    def test_the_pacer_runs_at_the_margin_times_the_configured_rate_which_config_and_health_still_name(self):
        """AWS counts a request when it arrives, after the CLI's own start-up, so grants exactly 1/R apart can arrive
        closer than that. The bucket refills at R x LAUNCH_RATE_MARGIN, a code constant (1.0: on the host each CLI
        send takes 1 to 4 s and spaces the launches by itself); Config.launch_rate stays R, the applied quota the
        operator checks."""
        self.assertEqual(getattr(module, "LAUNCH_RATE_MARGIN", None), MARGIN)
        for rate, burst in ((1.0, 1), (5.0, 5), (0.2, 1), (50.0, 50), (2, 3)):
            with self.subTest(rate=rate, burst=burst):
                bridge, _ = make(self, launch_rate=rate, launch_burst=burst)
                self.assertAlmostEqual(bridge.pacer.rate, rate * MARGIN, places=9)
                self.assertEqual(bridge.pacer.burst, burst, "the burst is not reduced")
                self.assertEqual((bridge.config.launch_rate, bridge.config.launch_burst), (rate, burst))
                health = bridge.health()
                self.assertEqual((health["launchRate"], health["launchBurst"]), (rate, burst))
                self.assertIs(type(health["launchRate"]), type(rate))

    def test_the_older_cases_shim_changes_only_the_pacing_defaults(self):
        old, new = test_bridge.Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS), Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS)
        self.assertIsInstance(old, Config)
        fields = [name for name in Config.__dataclass_fields__ if name not in ("launch_rate", "launch_burst")]
        self.assertEqual([getattr(old, name) for name in fields], [getattr(new, name) for name in fields])
        self.assertEqual((old.launch_rate, old.launch_burst), (50.0, 50))
        with self.assertRaises(ValueError): test_bridge.Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, launch_burst=51)


class PacerOrderTests(unittest.TestCase):
    def drained(self, rate, burst=1):
        pacer = LaunchPacer(rate, burst)
        for _ in range(burst): self.assertEqual(bounded(self, lambda: pacer.take(pacer.ticket()), 2), 0.0)
        return pacer

    def test_ten_concurrent_waiters_are_granted_in_ticket_order(self):
        for trial in range(3):
            with self.subTest(trial=trial):
                pacer, granted, guard = self.drained(20.0), [], threading.Lock()
                tickets = [pacer.ticket() for _ in range(10)]
                arrival = tickets[:]
                random.Random(trial).shuffle(arrival)  # the threads reach the pacer in any order
                def wait(ticket):
                    pacer.take(ticket)
                    with guard: granted.append(ticket)
                joined(self, [daemon(wait, ticket) for ticket in arrival], 5)
                self.assertEqual(granted, tickets)

    def test_a_re_entering_ticket_keeps_its_place_ahead_of_later_ones(self):
        pacer = self.drained(10.0)
        first, later = pacer.ticket(), [pacer.ticket() for _ in range(3)]
        granted, guard = [], threading.Lock()
        def wait(ticket):
            pacer.take(ticket)
            with guard: granted.append(ticket)
        threads = [daemon(wait, ticket) for ticket in later]
        self.assertTrue(wait_until(lambda: len(pacer.queue) == 3))
        bounded(self, lambda: wait(first), 2)  # arrives last, as a re-send does, and is still served first
        joined(self, threads, 5)
        self.assertEqual(granted, [first] + later)

    def test_a_later_ticket_never_takes_the_token_an_earlier_waiter_needs(self):
        import bisect
        pacer = self.drained(4.0)
        early, late = pacer.ticket(), pacer.ticket()
        with pacer.changed: bisect.insort(pacer.queue, early)  # an arrived waiter that has not re-checked yet
        time.sleep(.3)  # one token refilled: the earlier ticket's
        with self.assertRaises(PacingLate):
            bounded(self, lambda: pacer.take(late, latest=time.monotonic() + .05), 2)  # it would wait for the next one
        self.assertEqual(bounded(self, lambda: pacer.take(early), 2), 0.0, "the token was kept for the earlier ticket")
        # With a burst holding a token for each ticket ahead too, a later one goes at once and delays no one.
        roomy = LaunchPacer(4.0, 3)
        first, second = roomy.ticket(), roomy.ticket()
        with roomy.changed: bisect.insort(roomy.queue, first)
        self.assertEqual(bounded(self, lambda: roomy.take(second, latest=time.monotonic()), 2), 0.0)
        self.assertEqual(bounded(self, lambda: roomy.take(first), 2), 0.0)

    def test_the_rate_spaces_the_grants_and_the_burst_is_honoured(self):
        for rate, burst in ((10.0, 1), (10.0, 4)):
            with self.subTest(rate=rate, burst=burst):
                pacer = LaunchPacer(rate, burst)
                began = time.monotonic()
                waits = [bounded(self, lambda: pacer.take(pacer.ticket()), 2) for _ in range(burst + 3)]
                self.assertEqual(waits[:burst], [0.0] * burst, "the burst goes at once")
                for index, waited in enumerate(waits[burst:], 1):
                    self.assertAlmostEqual(waited, 1 / rate, delta=.04)
                self.assertAlmostEqual(time.monotonic() - began, 3 / rate, delta=.08)
                # An idle bucket refills to the burst and never beyond it.
                time.sleep((burst + 2) / rate)
                waits = [bounded(self, lambda: pacer.take(pacer.ticket()), 2) for _ in range(burst + 1)]
                self.assertEqual(waits[:burst], [0.0] * burst)
                self.assertGreater(waits[burst], .5 / rate)
                # A take counts nothing on its own: the bridge counts each launch that waited, once.
                self.assertEqual(pacer.totals(), (0, 0))

    def test_a_refund_returns_one_token_up_to_the_burst_and_wakes_the_head(self):
        pacer = self.drained(0.5)  # a token every 2 s
        outcome = {}
        def wait():
            ticket = pacer.ticket()
            outcome["waited"] = pacer.take(ticket)
        thread = daemon(wait)
        self.assertTrue(wait_until(lambda: len(pacer.queue) == 1))
        refunded = time.monotonic()
        pacer.refund()
        joined(self, [thread], 1)
        self.assertLess(time.monotonic() - refunded, .1, "the refunded token went to the waiter at once")
        full = LaunchPacer(1.0, 2)
        full.refund()
        self.assertEqual([bounded(self, lambda: full.take(full.ticket(), latest=time.monotonic()), 2) for _ in range(2)],
                         [0.0, 0.0])
        with self.assertRaises(PacingLate):
            bounded(self, lambda: full.take(full.ticket(), latest=time.monotonic() + .1), 2)  # never beyond the burst

    def test_a_grant_that_cannot_come_by_the_latest_instant_is_refused_before_it(self):
        pacer = self.drained(1.0)
        began = time.monotonic()
        with self.assertRaises(PacingLate): bounded(self, lambda: pacer.take(pacer.ticket(), latest=began + .5), 2)
        self.assertLess(time.monotonic() - began, .05, "refused at once on the projection")
        self.assertEqual(pacer.queue, [], "the refused ticket leaves the queue")
        # A grant needing no wait is never refused, even past its latest instant.
        fresh = LaunchPacer(1.0, 1)
        self.assertEqual(bounded(self, lambda: fresh.take(fresh.ticket(), latest=time.monotonic() - 5), 2), 0.0)
        # A waiter whose projection slips (an earlier ticket re-enters ahead of it) is refused at that wake,
        # never granted past its latest instant.
        pacer = self.drained(2.0)
        early, late = pacer.ticket(), pacer.ticket()
        outcome = {}
        def wait():
            try: outcome["waited"] = pacer.take(late, latest=time.monotonic() + .7)
            except PacingLate: outcome["refused"] = time.monotonic()
        thread = daemon(wait)
        self.assertTrue(wait_until(lambda: pacer.queue == [late]))
        deadline = time.monotonic() + .7
        other = daemon(pacer.take, early)
        joined(self, [thread, other], 3)
        self.assertIn("refused", outcome)
        self.assertLessEqual(outcome["refused"], deadline)


class BridgePacingTests(unittest.TestCase):
    def wave(self, bridge, count, seconds=30.0):
        results = [None] * count
        def run(index): results[index] = bridge.execute(JOB)
        joined(self, [daemon(run, index) for index in range(count)], seconds)
        return results

    def test_ten_launches_at_one_a_second_are_paced_one_interval_apart_at_the_rate_times_the_margin(self):
        cloud = SendLog()
        bridge, registry = make(self, cloud, job_limit=10, cleanup_limit=10, launch_rate=1.0, launch_burst=1)
        interval = 1 / (1.0 * MARGIN)
        began = time.monotonic()
        self.assertEqual(self.wave(bridge, 10), [RESULT] * 10)
        self.assertEqual(len(cloud.sends), 10)
        for index, (at, _) in enumerate(cloud.sends):
            self.assertAlmostEqual(at - cloud.sends[0][0], interval * index, delta=.15, msg="the %dth launch" % (index + 1))
        self.assertLess(time.monotonic() - began, 9 * interval + 2.0)
        gaps = [b[0] - a[0] for a, b in zip(cloud.sends, cloud.sends[1:])]
        self.assertGreaterEqual(min(gaps), interval - .05, "never two sends inside one token's refill at the margin")
        health = bridge.health()
        self.assertEqual((health["launchPaced"], health["launchRate"]), (9, 1.0))
        self.assertAlmostEqual(health["launchPacedMs"], sum(1000 * interval * index for index in range(10)), delta=400)
        for _, token in cloud.sends: self.assertIsNone(registry.get(token)["diagnostics_json"])

    def test_at_five_a_second_burst_five_the_burst_goes_at_once_and_the_rest_one_paced_interval_apart(self):
        cloud = SendLog()
        bridge, registry = make(self, cloud, job_limit=10, cleanup_limit=10, launch_rate=5.0, launch_burst=5)
        self.assertEqual(self.wave(bridge, 10), [RESULT] * 10)
        offsets = [at - cloud.sends[0][0] for at, _ in cloud.sends]
        for offset in offsets[:5]: self.assertLess(offset, .08, "the burst of five goes at once")
        for index, offset in enumerate(offsets[5:], 1):
            self.assertAlmostEqual(offset, index / (5.0 * MARGIN), delta=.08)
        health = bridge.health()
        self.assertEqual((health["launchPaced"], health["launchRate"], health["launchBurst"]), (5, 5.0, 5))

    def test_the_effective_interval_is_one_over_the_rate_times_the_margin(self):
        cloud = SendLog()
        bridge, _ = make(self, cloud, launch_rate=4.0, launch_burst=1, job_limit=4, cleanup_limit=4)  # 4 a second at the margin: 0.25 s a token
        self.assertEqual(self.wave(bridge, 4), [RESULT] * 4)  # all four waiting at once: the gaps are the pacer's own
        gaps = [b[0] - a[0] for a, b in zip(cloud.sends, cloud.sends[1:])]
        self.assertEqual(len(gaps), 3)
        for gap in gaps: self.assertAlmostEqual(gap, 1 / (4.0 * MARGIN), delta=.03)
        self.assertEqual(bridge.health()["launchRate"], 4.0)

    def test_launches_are_sent_in_admission_order(self):
        for trial in range(2):
            with self.subTest(trial=trial):
                cloud = SendLog()
                # Burst 1, the value this case was written at: with a fuller bucket the six go unqueued and the
                # order is not the pacer's.
                bridge, registry = make(self, cloud, job_limit=6, cleanup_limit=6, launch_rate=10.0, launch_burst=1)
                admitted, threads = [], []
                real_admit = bridge._admit
                def admit(*args, **options):
                    row = real_admit(*args, **options)
                    admitted.append(row["id"])
                    return row
                bridge._admit = admit
                for index in range(6):
                    threads.append(daemon(bridge.execute, JOB))
                    # Each run is admitted and waiting (or sent) before the next arrives.
                    self.assertTrue(wait_until(lambda: len(admitted) == index + 1 and (
                        len(bridge.pacer.queue) + len(cloud.sends)) == index + 1))
                joined(self, threads, 10)
                self.assertEqual([token for _, token in cloud.sends], admitted)

    def test_a_throttled_re_send_takes_a_token_in_its_own_place(self):
        cloud = SendLog()
        bridge, registry = make(self, cloud, launch_rate=2.0, launch_burst=1)  # 2 x MARGIN tokens a second: interval = 1 / (2 x MARGIN) s apart
        interval = 1 / (2.0 * MARGIN)
        first = {}
        real_launch = cloud.launch
        def launch(parameters):
            if not first: first["token"] = parameters["clientToken"]; cloud.throttle_first.add(parameters["clientToken"])
            return real_launch(parameters)
        cloud.launch = launch
        with patch("bridge.random.random", return_value=0.0):
            a = daemon(bridge.execute, JOB)
            self.assertTrue(wait_until(lambda: len(cloud.sends) == 1))
            b = daemon(bridge.execute, JOB)
            joined(self, [a, b], 10)
        tokens = [token for _, token in cloud.sends]
        self.assertEqual(tokens[:2], [first["token"]] * 2, "the throttled run re-sends before the later run")
        self.assertEqual(len(tokens), 3)
        times = [at for at, _ in cloud.sends]
        self.assertAlmostEqual(times[1] - times[0], interval, delta=.08, msg="the re-send waited for its token")
        self.assertAlmostEqual(times[2] - times[1], interval, delta=.08)
        health = bridge.health()
        self.assertEqual((health["launchThrottles"], health["launchPaced"]), (1, 2))
        self.assertAlmostEqual(health["launchPacedMs"], 1000 * (interval - .125) + 1000 * 2 * interval, delta=150)

    def test_a_launch_that_waits_for_its_send_and_again_for_its_re_send_is_counted_once(self):
        """Health's launchPaced counts launches that waited, not takes; launchPacedMs sums the waits."""
        cloud = SendLog()
        bridge, registry = make(self, cloud, launch_rate=5.0, launch_burst=1, cleanup_limit=2)  # 5 x MARGIN tokens a second
        self.assertEqual(bounded(self, lambda: bridge.execute(JOB)), RESULT)  # the full bucket's token: no wait
        self.assertEqual(bridge.health()["launchPaced"], 0)
        real_launch = cloud.launch
        def launch(parameters):
            if len(cloud.sends) == 1: cloud.throttle_first.add(parameters["clientToken"])  # the second run's first send
            return real_launch(parameters)
        cloud.launch = launch
        with patch("bridge.random.random", return_value=0.0):  # the backoff is 0.125 s
            self.assertEqual(bounded(self, lambda: bridge.execute(JOB)), RESULT)
        self.assertEqual(len(cloud.sends), 3)
        self.assertEqual(cloud.sends[1][1], cloud.sends[2][1])
        health = bridge.health()
        self.assertEqual((health["launchThrottles"], health["launchPaced"]), (1, 1), "one launch waited, twice")
        # The second run waits one interval for its send; its re-send, after the 0.125 s backoff, waits the rest of
        # the next interval (at margin 0.8: 250 + 125 ms; at 1.0: 200 + 75 ms).
        interval = 1 / (5.0 * MARGIN)
        self.assertAlmostEqual(health["launchPacedMs"], 1000 * interval + 1000 * (interval - .125), delta=100)

    def test_a_launch_whose_paced_wait_would_pass_the_budget_is_refused_early_by_name_and_released(self):
        cloud = SendLog()
        bridge, registry = make(self, cloud, boot_seconds=12, launch_rate=0.2, launch_burst=1)
        self.assertEqual(bounded(self, lambda: bridge.execute(JOB)), RESULT)
        # The first run's teardown done, so the refused run's own teardown thread finds the K = 1 claim free.
        self.assertTrue(wait_until(lambda: registry.stats()["job"] == 0 and not bridge.cleanup_slots.busy()))
        began = time.monotonic()
        with self.assertRaises(Unavailable) as refused:
            bounded(self, lambda: bridge.execute(JOB), 2)
        self.assertLess(time.monotonic() - began, .5, "refused at once, not after waiting")
        self.assertEqual(refused.exception.code, "launch_pacing_budget")
        self.assertEqual(refused.exception.stage, "launch")
        self.assertEqual(len(cloud.sends), 1, "the refused run never reached the provider")
        operation = refused.exception.operation_id
        self.assertTrue(wait_until(lambda: registry.get(operation)["state"] == "terminated"))
        row = registry.get(operation)
        self.assertEqual((row["last_error_code"], row["last_error_stage"], row["launch_attempts"], row["cleanup_outcome"]),
                         ("launch_pacing_budget", "launch", 0, "not-launched"))
        self.assertIsNone(row["diagnostics_json"], "a row with no guest diagnostics writes none")
        self.assertTrue(wait_until(lambda: registry.stats()["job"] == 0), "the slot is released")
        from serve import failure_diagnostic
        self.assertEqual(failure_diagnostic(refused.exception)["diagnosticCode"], "launch_pacing_budget")
        self.assertEqual(failure_diagnostic(refused.exception)["stage"], "launch")

    def test_the_budget_counts_the_wait_a_launch_inside_it_goes_and_its_wait_is_on_health(self):
        guest = Guest()
        guest.result = dict(RESULT, diagnostics={"version": 1, "wallMs": 905, "cpuUserMs": 600})
        cloud = SendLog()
        bridge, registry = make(self, cloud, guest, boot_seconds=12, launch_rate=1.0, launch_burst=1)
        bounded(self, lambda: bridge.execute(JOB))
        started = time.monotonic()
        # A wait of one paced interval (1 / (1 x MARGIN) s, 1 s at the shipped margin) fits the 2 s before the reserve.
        self.assertEqual(bounded(self, lambda: bridge.execute(JOB))["ok"], True)
        self.assertLess(time.monotonic() - started, 2.0)
        saved = json.loads(registry.get(cloud.sends[-1][1])["diagnostics_json"])
        self.assertEqual(saved, safe_diagnostics(guest.result["diagnostics"]), "the guest's sanitized fields only")
        self.assertNotIn("launchPacedMs", saved)
        health = bridge.health()
        self.assertEqual(health["launchPaced"], 1)
        self.assertAlmostEqual(health["launchPacedMs"], 1000 / MARGIN, delta=150)

    def test_rows_carry_no_paced_wait_and_a_job_rows_diagnostics_are_the_sanitizers_own(self):
        """No row carries the paced wait. A row the guest gave no diagnostics keeps NULL; a job row's
        diagnostics equal safe_diagnostics of themselves; a guest never writes a
        controller field."""
        cloud, guest = SendLog(), Guest()
        bridge, registry = make(self, cloud, guest, launch_rate=5.0, launch_burst=1, job_limit=6, cleanup_limit=6)
        for _ in range(3): self.assertEqual(bounded(self, lambda: bridge.execute(JOB)), RESULT)
        self.assertGreaterEqual(bridge.health()["launchPaced"], 1, "these launches were paced")
        for _, token in cloud.sends: self.assertIsNone(registry.get(token)["diagnostics_json"])
        view = bounded(self, lambda: bridge.start(PREVIEW))
        self.assertTrue(wait_until(lambda: registry.get(view["id"])["state"] == "running"))
        self.assertIsNone(registry.get(view["id"])["diagnostics_json"], "a preview row writes none")
        bridge.app("stop", {"id": view["id"]})
        for given in ({"version": 1, "wallMs": 905, "launchPacedMs": 999999},
                      {"version": 1, "wallMs": 905, "cpuUserMs": 600, "stages": [{"stage": "complete", "atMs": 7}]}):
            with self.subTest(given=given):
                guest.result = dict(RESULT, diagnostics=given)
                self.assertEqual(bounded(self, lambda: bridge.execute(JOB)), RESULT)
                saved = json.loads(registry.get(cloud.sends[-1][1])["diagnostics_json"])
                self.assertEqual(saved, safe_diagnostics(saved))
                self.assertEqual(saved, safe_diagnostics(given))
                self.assertNotIn("launchPacedMs", saved, "a guest never writes a controller field")

    def test_a_shutdown_wakes_a_waiting_launch_at_once(self):
        cloud = SendLog()
        bridge, registry = make(self, cloud, launch_rate=0.2, launch_burst=1)
        bounded(self, lambda: bridge.execute(JOB))
        outcome = {}
        def run():
            try: bridge.execute(JOB)
            except Unavailable as error: outcome["code"], outcome["at"] = error.code, time.monotonic()
        thread = daemon(run)
        self.assertTrue(wait_until(lambda: len(bridge.pacer.queue) == 1))
        time.sleep(.05)
        stopped = time.monotonic()
        bounded(self, bridge.shutdown, 5)
        joined(self, [thread], 5)
        self.assertEqual(outcome.get("code"), "operation_cancelled")
        self.assertLess(outcome["at"] - stopped, .1, "woken by the stop, not by a poll")
        self.assertEqual(len(cloud.sends), 1, "the waiting launch was never sent")
        self.assertEqual(bridge.pacer.queue, [])

    def test_a_preview_stop_wakes_its_waiting_start(self):
        cloud = SendLog()
        bridge, registry = make(self, cloud, launch_rate=0.2, launch_burst=1)
        bounded(self, lambda: bridge.execute(JOB))
        view = bounded(self, lambda: bridge.start(PREVIEW))
        self.assertTrue(wait_until(lambda: len(bridge.pacer.queue) == 1))
        time.sleep(.05)
        stopped = time.monotonic()
        bounded(self, lambda: bridge.app("stop", {"id": view["id"]}), 5)
        self.assertTrue(wait_until(lambda: registry.get(view["id"])["state"] == "terminated", 1.0))
        self.assertLess(time.monotonic() - stopped, .15)
        self.assertEqual(registry.get(view["id"])["cleanup_outcome"], "not-launched")
        self.assertEqual(len(cloud.sends), 1)
        self.assertEqual(bridge.pacer.queue, [])

    def test_no_lock_is_held_while_a_launch_waits_for_its_token(self):
        cloud = SendLog()
        bridge, registry = make(self, cloud, launch_rate=0.2, launch_burst=1, job_limit=3, cleanup_limit=1)
        bounded(self, lambda: bridge.execute(JOB))
        thread = daemon(lambda: self.assertRaises(Unavailable, bridge.execute, JOB))
        self.assertTrue(wait_until(lambda: len(bridge.pacer.queue) == 1))
        time.sleep(.3)  # past one poll: the waiter is parked in its wait
        for name, call in (("health", bridge.health), ("registry", registry.stats),
                           ("active_lock", lambda: bridge.active_lock.acquire(timeout=.05) and bridge.active_lock.release() is None),
                           ("admission", lambda: bridge._released(bridge._admit("job", encode(JOB), deadline=time.monotonic() + .05)["id"])),
                           ("owner", lambda: bridge.lookup_owner({"kind": "preview", "ownerId": "a" * 24}))):
            with self.subTest(call=name):
                began = time.monotonic()
                result = bounded(self, call, 2)
                self.assertLess(time.monotonic() - began, .05)
                if name == "active_lock": self.assertTrue(result)
        bounded(self, bridge.shutdown, 5)
        joined(self, [thread], 5)

    def test_the_teardown_replay_waits_its_turn_for_a_token(self):
        cloud = SendLog()
        bridge, registry = make(self, cloud, launch_rate=2.0, launch_burst=1)  # 0.5 s a token at the margin
        row = unknown_launch(bridge, registry)
        bounded(self, lambda: bridge.execute(JOB))  # takes the one token
        taken = cloud.sends[-1][0]
        self.assertTrue(wait_until(lambda: registry.stats()["job"] == 1 and not bridge.cleanup_slots.busy()))
        bounded(self, lambda: bridge.cleanup_one(row["id"]), 5)
        replay = cloud.sent(row["id"])
        self.assertEqual(len(replay), 1)
        self.assertAlmostEqual(replay[0] - taken, 1 / (2.0 * MARGIN), delta=.1, msg="the replay was paced")
        saved = registry.get(row["id"])
        self.assertEqual((saved["state"], saved["cleanup_outcome"], saved["launch_attempts"]), ("terminated", "provider-terminated", 2))
        self.assertIsNone(saved["diagnostics_json"])
        health = bridge.health()
        self.assertEqual(health["launchPaced"], 1)
        self.assertAlmostEqual(health["launchPacedMs"], 1000 / (2.0 * MARGIN), delta=100)

    def test_a_replay_the_pacer_cannot_serve_in_time_is_not_sent_and_not_spent(self):
        cloud = SendLog()
        bridge, registry = make(self, cloud, launch_rate=0.2, launch_burst=1)
        row = bridge._admit("job", encode(JOB))
        row = registry.update(row["id"], launch_attempts=1, cleanup=1, state="cleanup", expires=time.time() + 1)
        bridge._released(row["id"])
        bounded(self, lambda: bridge.execute(JOB))
        self.assertTrue(wait_until(lambda: registry.stats()["job"] == 1 and not bridge.cleanup_slots.busy()))
        began = time.monotonic()
        bounded(self, lambda: bridge.cleanup_one(row["id"]), 2)
        self.assertLess(time.monotonic() - began, .2)
        saved = registry.get(row["id"])
        self.assertEqual((saved["launch_attempts"], saved["state"], saved["cleanup_error_code"]),
                         (1, "cleanup", "launch_pacing_budget"))
        self.assertEqual(cloud.sent(row["id"]), [])
        self.assertEqual(bridge.pacer.queue, [])

    def test_no_cleanup_claim_is_held_while_a_replay_waits_for_its_token(self):
        """At K = 1, while a replay waits for its token, another row's own teardown claims and confirms."""
        cloud = SendLog()
        bridge, registry = make(self, cloud, launch_rate=1.0, launch_burst=1, job_limit=3, cleanup_limit=1)  # 1 / (1 x MARGIN) s a token
        row = unknown_launch(bridge, registry)
        other = bounded(self, lambda: bridge._launch(bridge._admit("job", encode(JOB))))  # takes the one token
        bridge._released(other["id"])
        waiting = daemon(bridge.cleanup_one, row["id"])
        self.assertTrue(wait_until(lambda: len(bridge.pacer.queue) == 1))
        self.assertEqual(bridge.cleanup_slots.running, set(), "the waiting replay holds no cleanup claim")
        registry.update(other["id"], cleanup=1, state="cleanup")
        began = time.monotonic()
        bounded(self, lambda: bridge.cleanup_one(other["id"]), 2)
        self.assertLess(time.monotonic() - began, .2)
        saved = registry.get(other["id"])
        self.assertEqual((saved["state"], saved["cleanup_outcome"]), ("terminated", "provider-terminated"))
        self.assertEqual(cloud.sent(row["id"]), [], "confirmed while the replay still waited")
        joined(self, [waiting], 5)
        replayed = registry.get(row["id"])
        self.assertEqual((replayed["state"], replayed["cleanup_outcome"], replayed["launch_attempts"]),
                         ("terminated", "provider-terminated", 2))
        self.assertEqual(len(cloud.sent(row["id"])), 1)

    def test_a_replay_token_left_unused_goes_back_to_the_bucket(self):
        """A replay whose claim fails, or whose row no longer needs it once claimed, sends nothing and
        refunds its token, so the next launch is not delayed by a token nobody used."""
        for case in ("claim-taken", "no-longer-needed"):
            with self.subTest(case=case):
                cloud = SendLog()
                # Burst 1, the value this case was written at: the one token is the replay's, so only its refund
                # serves the next launch at once (5 s a token at the margin; the bucket is full).
                bridge, registry = make(self, cloud, launch_rate=0.2, launch_burst=1, job_limit=3)
                row = unknown_launch(bridge, registry)
                real_take = bridge.pacer.take
                if case == "claim-taken":
                    self.assertTrue(bridge.cleanup_slots.claim("held"))
                else:
                    def take(*args, **options):
                        waited = real_take(*args, **options)
                        # Another pass confirmed the row in between: once claimed, the replay is no longer needed.
                        registry.update(row["id"], state="terminated", cleanup_outcome="provider-terminated")
                        return waited
                    bridge.pacer.take = take
                bounded(self, lambda: bridge.cleanup_one(row["id"]), 2)
                self.assertEqual(cloud.sent(row["id"]), [], "no replay was sent")
                self.assertEqual(registry.get(row["id"])["launch_attempts"], 1)
                bridge.cleanup_slots.release("held")
                bridge.pacer.take = real_take
                began = time.monotonic()
                self.assertEqual(bounded(self, lambda: bridge.execute(JOB), 3), RESULT)
                self.assertLess(time.monotonic() - began, .5, "the refunded token served the next launch at once")
                self.assertEqual(bridge.health()["launchPaced"], 0, "a refunded replay is not a paced launch")

    def test_a_shutdown_wakes_a_waiting_replay_at_once(self):
        """A replay waiting for its token sees a shutdown at once and sends nothing; shutdown's own sweep then
        gives the row its one replay."""
        cloud = SendLog()
        bridge, registry = make(self, cloud, launch_rate=2.0, launch_burst=1, job_limit=3)  # 0.5 s a token at the margin
        row = unknown_launch(bridge, registry)
        other = bounded(self, lambda: bridge._launch(bridge._admit("job", encode(JOB))))  # takes the one token
        bridge._released(other["id"])
        outcome = {}
        def replay():
            bridge.cleanup_one(row["id"])
            outcome["returned"], outcome["sent"] = time.monotonic(), list(cloud.sent(row["id"]))
        waiting = daemon(replay)
        self.assertTrue(wait_until(lambda: len(bridge.pacer.queue) == 1))
        time.sleep(.05)
        stopped = time.monotonic()
        stopping = daemon(bridge.shutdown)
        joined(self, [waiting], 2)
        self.assertLess(outcome["returned"] - stopped, .1, "woken by the stop, not by its grant")
        self.assertEqual(outcome["sent"], [], "the woken replay sent nothing")
        joined(self, [stopping], 10)
        saved = registry.get(row["id"])
        self.assertEqual((saved["state"], saved["launch_attempts"], len(cloud.sent(row["id"]))), ("terminated", 2, 1))
        self.assertEqual(bridge.pacer.queue, [])

    def test_the_recorded_teardown_order_holds_at_the_code_default_pacing(self):
        """test_bridge's recorded sequence, run at the code's own pacing (5 a second, burst 5, at the margin) with a
        boot budget wide enough for the waits: the same calls in the same order, the literal untouched."""
        def config(*args, **options):
            return Config(*args, **{**options, "boot_seconds": 60})
        with patch.object(test_bridge, "Config", config):
            self.assertEqual(bounded(self, lambda: test_bridge.cleanup_scenario(job_limit=2, cleanup_limit=1), 60),
                             RECORDED_SERIAL_SEQUENCE)


if __name__ == "__main__": unittest.main()
