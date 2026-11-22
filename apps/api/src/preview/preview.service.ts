import { BadRequestException, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { DataSource } from 'typeorm';
import {
  PREVIEW_CLEANUP_HELD_MESSAGE, PREVIEW_DISABLED_MESSAGE, PREVIEW_ISOLATION_MESSAGE, PREVIEW_PAUSED_MESSAGE,
  PREVIEW_RUNNER_UNAVAILABLE_MESSAGE, PREVIEW_UNAVAILABLE_MESSAGE,
  type PreviewLogLine, type PreviewSessionView, type PreviewStatus, type PreviewStopReason,
} from '@learnsdlc/shared';
import { API_PREFIX, config } from '../config';
import { ContentService } from '../content/content.service';
import { SANDBOX_BUSY_MESSAGE } from '../execution/run-gate';
import { rowLock } from '../db/atomic';
import { SandboxService, previewUnsupported, PREVIEW_START_HEADROOM_SECONDS,
  type SandboxAppJob, type SandboxAppSession } from '../execution/sandbox.service';
import { recordAudit } from '../audit/audit';
import { WorkflowService } from '../workflow/workflow.service';
import { AuthService } from '../auth/auth.service';
import { UserEntity } from '../db/entities';
import { PreviewSessionEntity } from './preview-session.entity';
import { PreviewSessionStore } from './preview-session.store';
import type { PreviewRefusalReason, PreviewSessionAnswer } from './preview.dto';

type LiveSession = PreviewSessionEntity;
export const PREVIEW_DOOR_PREFIX = `${API_PREFIX}/preview`;
const CAPABILITY_BYTES = 24;
const MAX_CAPABILITY_CHARS = 200;
const REMEMBER_MS = 5 * 60_000;
const LIVE: PreviewStatus[] = ['starting', 'ready'];
const occupies = (row: LiveSession) => LIVE.includes(row.status) || row.cleanupPending;
/**
 * A seat the bounded clean-up gave up asking about: still held, because
 * elapsed time is not proof the app stopped, and asked about again only when
 * its owner presses Run app.
 */
const heldUnconfirmed = (row: LiveSession) => row.cleanupPending && !!row.state.cleanupAbandonedAt;

/**
 * How long a row may go on asking the runner to confirm its clean-up.
 *
 * The first few asks are made whenever something reaches the row: a sweep, a
 * poll, a Stop, because a runner that was restarting answers within seconds.
 * After them each ask waits twice as long as the last, from thirty seconds up
 * to ten minutes, and after the eighth the row is marked failed and nothing
 * asks again: about sixteen minutes of asking in all, rather than one local
 * runner spawned every thirty seconds for as long as the row exists. The seat
 * stays reserved throughout and after: elapsed time is not proof the app
 * stopped, and the operator is told once, by name.
 */
export const CLEANUP_IMMEDIATE_ATTEMPTS = 3;
export const CLEANUP_MAX_ATTEMPTS = 8;
const CLEANUP_BACKOFF_MS = 30_000;
const CLEANUP_BACKOFF_CAP_MS = 10 * 60_000;

/**
 * What a Run app or Rebuild press is told when the one thing in its way is the
 * learner's own earlier preview, stopped but not yet confirmed gone.
 * Not SANDBOX_BUSY_MESSAGE: no other learner holds the seat, so "busy with
 * the rest of the class" would be untrue. The answer also carries `reason`
 * `own-preview-stopping`, which the panel titles the state by; the sentence
 * is what a client that does not read that field draws.
 */
export const PREVIEW_OWN_STOPPING_MESSAGE =
  'Your earlier preview is still stopping. Your work is saved. Try again in a moment.';

/**
 * What a press is told when the one thing in its way is another start of the
 * learner's own that is still launching (a second tab), with `reason`
 * `own-preview-starting`. Not SANDBOX_BUSY_MESSAGE, for the same reason.
 */
export const PREVIEW_OWN_STARTING_MESSAGE = 'Your preview is already starting. Give it a moment.';

/**
 * How long a press waits for the learner's own earlier preview to be
 * confirmed stopped before it reserves a seat. All times are from the
 * press (just before its own stop).
 *
 * A Rebuild stops the running app and starts the new one in one press. A
 * stop's first ask may come back unconfirmed, so the press asks again while
 * the old row is still pending: `pauseMs` after each answer, at most `asks`
 * more times, none begun later than `lastAskMs`, and the whole wait given up
 * at `ceilingMs` whatever the runner is doing (an ask still out then is left
 * to finish on its own; its answer is read like any other, and until the
 * runner confirms, the row keeps its seat and the sweep asks later).
 *
 * The sizes allow for a runner whose stop tears a virtual machine down in
 * line: such a stop may answer after about three seconds, unconfirmed, and be
 * confirmed a few seconds later. Re-asking for up to about nine seconds lands
 * a confirmation that arrives within about eight seconds of the press on the
 * press itself. Asks that come back at once (a runner holding the teardown
 * for its own sweep, or a local runner) are spaced by the pause and capped by
 * `asks`, which still reaches about nine seconds.
 *
 * Bound: an ask may take two control timeouts (PREVIEW_CONTROL_TIMEOUT_MS,
 * 10 s each), so the ceiling is enforced on the wait, not on the asks. The
 * wait ends no later than `ceilingMs` after the press, or at once when the
 * press's own stop took longer than that, so it adds at most `ceilingMs` and
 * never lengthens a press past what its own stop already took (up to 20 s).
 * With an ordinary stop the press is at the reservation by about 12 s, inside
 * the web client's 20 s request timeout.
 *
 * These asks are the owner's press, so they are not counted against the
 * clean-up bound; the seat stays reserved until the runner confirms. Mutable
 * only so the tests can shorten it.
 */
export const OWN_STOP_WAIT = { asks: 8, pauseMs: 750, lastAskMs: 9_000, ceilingMs: 12_000 };

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Whether this row may ask the runner about its clean-up at `now`. */
function cleanupDue(row: LiveSession, now: number): boolean {
  if (row.state.cleanupAbandonedAt) return false;
  const attempts = row.state.cleanupAttempts ?? 0;
  if (attempts < CLEANUP_IMMEDIATE_ATTEMPTS) return true;
  const last = row.state.cleanupLastAttemptAt ?? 0;
  const wait = Math.min(CLEANUP_BACKOFF_MS * 2 ** (attempts - CLEANUP_IMMEDIATE_ATTEMPTS), CLEANUP_BACKOFF_CAP_MS);
  // A clock that reads earlier than the last ask is no reason to keep waiting.
  return now < last || now >= last + wait;
}

/** Shared preview ownership. The controller owns processes; the database owns
 * capability revocation and capacity. A replica restart cannot orphan ownership
 * or accidentally stop another replica's previews. */
@Injectable()
export class PreviewService {
  private readonly logger = new Logger(PreviewService.name);
  private readonly store: PreviewSessionStore;

  constructor(
    private readonly workflow: WorkflowService,
    private readonly content: ContentService,
    private readonly sandbox: SandboxService,
    private readonly dataSource: DataSource,
    @Optional() auth?: AuthService,
  ) {
    this.store = new PreviewSessionStore(dataSource);
    auth?.onSessionRevoked(userId => {
      void this.stopOwn(userId, 'learner').catch(() => {
        this.logger.warn('revoked preview cleanup remains pending');
      });
    });
  }

  async start(userId: string, phaseStateId: string, sessionVersion = 0): Promise<PreviewSessionAnswer> {
    const { state, phase, enrollment } = await this.workflow.loadOwnedState(userId, phaseStateId);
    // The learner's own version decides whether there is an app
    // and how it starts. `phase` already came from the pinned version through
    // `loadOwnedState`, so reading the head here would pair one version's phase
    // with another version's `preview` block, which is the build and the
    // health check of a service this learner's files were never written
    // against. A null pin answers the published head.
    const project = this.content.getForEnrollment(enrollment);
    if (!phase.canPreview || !project.preview) throw new BadRequestException('this phase has no app to run');
    const unsupported = previewUnsupported();
    if (unsupported) return this.unsupportedView(phaseStateId, unsupported);
    await this.requireAuthority(userId, sessionVersion);
    // The transport, before a seat is reserved. The
    // local runner is started here if it has to be, and its own health says
    // whether it can isolate learner code: a runner that cannot is refused
    // in the sentence Submit uses, and one that could not be reached at all
    // is not "turned off". Either way nothing is reserved: no request was
    // sent, so no launch can be hiding behind the refusal.
    if (!(await this.sandbox.previewSocket())) {
      return this.unsupportedView(phaseStateId, previewUnsupported() ?? 'runner');
    }
    // A seat of this learner's that the bounded clean-up gave up on: their
    // press is the one thing that asks the runner again (once
    // per press, never on a timer) and a confirmed stop frees it here.
    for (const row of await this.liveSessions()) {
      if (row.userId === userId && heldUnconfirmed(row)) await this.cleanup(row, Date.now(), true);
    }
    if ((await this.liveSessions()).some(row => row.userId === userId && heldUnconfirmed(row))) {
      return this.refusedView(phaseStateId, 'unavailable', PREVIEW_CLEANUP_HELD_MESSAGE);
    }
    const unnamed = (await this.liveSessions()).filter(row => row.userId === userId && !row.runnerId);
    if (unnamed.length) {
      // The learner's own start the runner has not named yet: one still
      // launching (a second tab), or one stopped before it was named. Said as
      // that, never as the class being busy.
      return this.refuseOwn(phaseStateId, unnamed);
    }
    const pressedAt = Date.now();
    await this.stopOwn(userId, 'learner');
    await this.settleOwnStop(userId, pressedAt);

    const capability = randomBytes(CAPABILITY_BYTES).toString('base64url');
    const now = Date.now();
    // Both bounded gates precede the bounded launch request. This deadline
    // ends publication; it never proves that an uncertain VM has terminated.
    const launchDeadline = now + 2 * config.runnerMaxWaitMs +
      (config.previewBuildSeconds + PREVIEW_START_HEADROOM_SECONDS) * 1000;
    let paused = false;
    let own: LiveSession[] = [];
    const reserved = await this.store.transaction(async manager => {
      await this.requireAuthority(userId, sessionVersion, manager);
      const rows = await manager.find(PreviewSessionEntity);
      const held = rows.filter(occupies);
      own = rows.filter(row => row.userId === userId && occupies(row));
      // Only this learner's own app is in the way (an earlier one not yet
      // confirmed gone, or another start of theirs): said as that, not as the
      // class being busy.
      if (own.length) return null;
      if (held.length >= config.previewSessions) {
        // Every seat held by a session nobody can confirm stopped is not the
        // class being busy, and trying again in a moment will not change it.
        paused = held.every(heldUnconfirmed);
        return null;
      }
      return manager.save(PreviewSessionEntity, manager.create(PreviewSessionEntity, {
        id: randomBytes(12).toString('hex'), userId, phaseStateId, tokenVersion: sessionVersion,
        runnerId: null, capabilityHash: sha256(capability).toString('hex'), status: 'starting',
        cleanupPending: false, revision: 0,
        state: { bundleOk: true, message: null, stopReason: null, startedAt: now, readyAt: null,
          expiresAt: launchDeadline, lastSeenAt: now, bytesServed: 0, forgetAt: null,
          buildMs: 0, launchDeadline,
          // The save these files are: read with them, so the panel can tell
          // a preview built from an earlier save from a current one.
          builtFromVersion: state.workspaceUpdatedAt ?? null },
      }));
    });
    if (!reserved) {
      if (paused) return this.refusedView(phaseStateId, 'unavailable', PREVIEW_PAUSED_MESSAGE);
      return own.length ? this.refuseOwn(phaseStateId, own) : this.refusedView(phaseStateId, 'busy', SANDBOX_BUSY_MESSAGE);
    }

    const preview = project.preview;
    const job: SandboxAppJob = {
      mode: 'preview', files: this.content.executionFiles(phase, state.workspace),
      ...(project.build ? { build: { ...project.build } } : {}),
      service: preview.service, web: preview.web, env: preview.env,
      ...(preview.seed ? { seed: preview.seed } : {}),
      ttlSeconds: config.previewMaxSeconds, idleSeconds: config.previewIdleSeconds, memoryMb: config.previewMemoryMb,
    };
    let answer: SandboxAppSession;
    try {
      answer = await this.sandbox.startApp(job, { kind: 'preview', ownerId: reserved.id, stepId: 'app' });
    } catch (error) {
      await this.markStopped(reserved.id, 'learner');
      throw error;
    }
    // Always retain the exact runner identity, even when logout/stop won while
    // launch was pending. That row is the next replica's cleanup instruction.
    let published = false;
    let session: LiveSession | null;
    try {
      session = await this.store.change(reserved.id, async (row, manager) => {
        if (row.runnerId && row.runnerId !== answer.id) return false;
        if (answer.id) row.runnerId = answer.id;
        const current = await this.store.current(row, manager);
        if (!current || !LIVE.includes(row.status) || Date.now() >= row.state.launchDeadline) {
          this.stopped(row, 'learner'); return true;
        }
        if (answer.status === 'busy' && !answer.id) {
          row.status = 'busy'; row.cleanupPending = false; row.state.forgetAt = Date.now() + REMEMBER_MS; return true;
        }
        if (answer.status === 'unavailable' || answer.status === 'busy') {
          // A transport failure may hide an accepted launch. Keep capacity until
          // the controller positively confirms cleanup; elapsed time is not proof.
          this.stopped(row, 'learner'); return true;
        }
        row.status = answer.status as PreviewStatus;
        row.state.bundleOk = answer.bundleOk !== false;
        row.state.message = answer.message ?? null;
        row.state.stopReason = (answer.stopReason as PreviewStopReason) ?? null;
        row.state.buildMs = Date.now() - now;
        row.state.expiresAt = Date.now() + config.previewMaxSeconds * 1000;
        row.state.lastSeenAt = Date.now();
        this.terminalCleanup(row, answer);
        published = true;
        return true;
      });
    } catch (error) {
      if (answer.id) await this.sandbox.stopApp(answer.id, 'learner');
      throw error;
    }
    if (!session || !published) {
      if (session) await this.cleanup(session);
      else if (answer.id) await this.sandbox.stopApp(answer.id, 'learner');
      await this.requireAuthority(userId, sessionVersion);
      // Not "turned off" for every transport failure: the runner's own
      // reason, or that it could not be reached.
      if (answer.status === 'unavailable') {
        return this.unsupportedView(phaseStateId, previewUnsupported() ?? 'runner', answer.message);
      }
      if (answer.status === 'busy') return this.refusedView(phaseStateId, 'busy', SANDBOX_BUSY_MESSAGE);
      throw new UnauthorizedException('this preview was stopped before it could open');
    }
    await this.audit('preview.start', session, { buildMs: session.state.buildMs });
    // Audit I/O must not allow a late start response to publish a revoked door.
    const current = await this.store.get(session.id);
    if (!current || current.status !== session.status || !await this.store.current(current)) {
      if (current) await this.finish(current, 'learner');
      throw new UnauthorizedException('this session has been signed out');
    }
    return this.view(current, answer, LIVE.includes(current.status) ? capability : null, state.workspaceUpdatedAt ?? null);
  }

  async status(userId: string, phaseStateId: string, cursor = 0): Promise<PreviewSessionAnswer | null> {
    // The phase row is read here anyway (ownership); its save stamp rides on
    // the answer, so the poll the panel already makes tells it when a save or
    // an Apply has moved past the build the app is serving.
    const { state } = await this.workflow.loadOwnedState(userId, phaseStateId);
    const saved = state.workspaceUpdatedAt ?? null;
    const session = await this.ownSession(userId, phaseStateId);
    if (!session) return null;
    if (!await this.store.current(session)) {
      await this.finish(session, 'learner');
      return this.view((await this.store.get(session.id))!, null, null, saved);
    }
    if (!LIVE.includes(session.status) || !session.runnerId) return this.view(session, null, null, saved);
    await this.touch(session.id);
    const answer = await this.sandbox.statusApp(session.runnerId, cursor);
    let answerApplied = false;
    const refreshed = await this.store.change(session.id, async (row, manager) => {
      if (!LIVE.includes(row.status)) return false;
      if (!await this.store.current(row, manager)) { this.stopped(row, 'learner'); return true; }
      this.absorb(row, answer); answerApplied = true; return true;
    });
    if (!refreshed) return null;
    if (refreshed.cleanupPending) await this.cleanup(refreshed);
    return this.view(refreshed, answerApplied ? answer : null, null, saved);
  }

  async stop(userId: string, phaseStateId: string): Promise<{ stopped: boolean }> {
    await this.workflow.loadOwnedState(userId, phaseStateId);
    const session = await this.ownSession(userId, phaseStateId);
    if (!session) return { stopped: false };
    await this.finish(session, 'learner');
    return { stopped: true };
  }

  /** The capability remains a bearer credential. Every door checks the shared
   * status and the owner's current token generation before contacting a runner. */
  async resolve(capability: string): Promise<LiveSession | null> {
    if (!capability || capability.length > MAX_CAPABILITY_CHARS) return null;
    const offered = sha256(capability);
    const rows = await this.store.all();
    let found: LiveSession | null = null;
    for (const row of rows) {
      const digest = Buffer.from(row.capabilityHash, 'hex');
      if (digest.length === offered.length && timingSafeEqual(offered, digest)) found = row;
    }
    if (!found || !LIVE.includes(found.status) || !found.runnerId) return null;
    const current = await this.touch(found.id);
    if (!current || !LIVE.includes(current.status)) {
      if (current?.cleanupPending) void this.cleanup(current).catch(() => this.logger.warn('preview cleanup remains pending'));
      return null;
    }
    return current;
  }

  runnerIdOf(session: LiveSession): string {
    if (!session.runnerId) throw new BadRequestException('preview is still starting');
    return session.runnerId;
  }

  async sweep(now = Date.now()): Promise<number> {
    let stopped = 0;
    for (const sampled of await this.store.all()) {
      const row = await this.store.change(sampled.id, async (fresh, manager) => {
        if (fresh.revision !== sampled.revision) return false;
        if (LIVE.includes(fresh.status)) {
          if (!await this.store.current(fresh, manager)) this.stopped(fresh, 'learner');
          else if (now > fresh.state.expiresAt) this.stopped(fresh, 'expired');
          else if (fresh.runnerId && now > fresh.state.lastSeenAt + config.previewIdleSeconds * 1000) this.stopped(fresh, 'idle');
          else return false;
          stopped += 1;
          return true;
        }
        return false;
      });
      if (!row) continue;
      if (row.cleanupPending) await this.cleanup(row, now);
      else if (await this.purgeOrphan(row)) continue;
      else if (row.state.forgetAt && now > row.state.forgetAt) {
        await this.store.transaction(async manager => {
          await manager.delete(PreviewSessionEntity, { id: row.id, revision: row.revision, cleanupPending: false });
        });
      }
    }
    return stopped;
  }

  async stopAll(reason: PreviewStopReason = 'shutdown'): Promise<number> {
    const live = await this.liveSessions();
    for (const row of live) await this.finish(row, reason);
    return live.length;
  }

  async liveSessions(): Promise<LiveSession[]> { return (await this.store.all()).filter(occupies); }

  private async ownSession(userId: string, phaseStateId: string): Promise<LiveSession | null> {
    const rows = (await this.store.all()).filter(row => row.userId === userId && row.phaseStateId === phaseStateId);
    return rows.find(occupies) ?? rows.sort((a, b) => b.state.startedAt - a.state.startedAt)[0] ?? null;
  }

  private async stopOwn(userId: string, reason: PreviewStopReason): Promise<void> {
    for (const row of await this.liveSessions()) if (row.userId === userId) await this.finish(row, reason);
  }

  /**
   * After a press stopped the learner's own app: ask the runner again, a few
   * times inside `OWN_STOP_WAIT`, while that stop is still unconfirmed.
   *
   * Only rows that still have a runner to ask, that the clean-up bound has
   * not given up on (those get their one ask per press above), and whose
   * counted asks have not yet reached the back-off: three misses in a row mean
   * the runner is in trouble, and a press then adds no asks of its own to its
   * load (on a runner backed by virtual machines each ask may be several
   * provider calls). Nothing here frees a seat by itself: a row leaves only
   * when `cleanup` hears the runner confirm.
   */
  private async settleOwnStop(userId: string, pressedAt: number): Promise<void> {
    const { asks, pauseMs, lastAskMs, ceilingMs } = OWN_STOP_WAIT;
    const left = pressedAt + ceilingMs - Date.now();
    if (left <= 0) return;
    let over = false;
    const settle = async () => {
      for (let ask = 0; ask < asks && !over; ask += 1) {
        const pending = (await this.liveSessions()).filter(row =>
          row.userId === userId && row.cleanupPending && !!row.runnerId && !heldUnconfirmed(row) &&
          (row.state.cleanupAttempts ?? 0) < CLEANUP_IMMEDIATE_ATTEMPTS);
        if (over || !pending.length || Date.now() - pressedAt + pauseMs >= lastAskMs) return;
        await pause(pauseMs);
        for (const row of pending) {
          if (over) return;
          await this.cleanup(row, Date.now(), true, false);
        }
      }
    };
    // A runner that answers slowly, hangs or errors costs the press no more
    // than the ceiling: the wait is given up then, and an ask still out is
    // left to finish by itself (uncounted, so it frees nothing unless the
    // runner confirms). Its failure is not the press's: the reservation below
    // reads whatever is true.
    const asking = settle().catch(error => {
      this.logger.warn(`preview own-stop settle: ${(error as Error).message}`);
    });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([asking, new Promise<void>(resolve => { timer = setTimeout(resolve, left); })]);
    over = true;
    clearTimeout(timer);
  }

  private async requireAuthority(userId: string, version: number, manager = this.dataSource.manager): Promise<void> {
    const user = await manager.findOne(UserEntity, { where: { id: userId }, select: ['id', 'tokenVersion', 'disabledAt'],
      ...(manager.queryRunner?.isTransactionActive ? rowLock(this.dataSource, 'pessimistic_read') : {}),
    });
    if (!user || user.disabledAt || !Number.isSafeInteger(version) || user.tokenVersion !== version) {
      throw new UnauthorizedException('this session has been signed out');
    }
  }

  private stopped(row: LiveSession, reason: PreviewStopReason): void {
    if (!occupies(row)) return;
    row.status = 'stopped'; row.cleanupPending = true;
    row.state.stopReason = reason; row.state.message = null;
    row.state.forgetAt = Date.now() + REMEMBER_MS;
  }

  private markStopped(id: string, reason: PreviewStopReason): Promise<LiveSession | null> {
    return this.store.change(id, row => {
      if (!LIVE.includes(row.status)) return false;
      this.stopped(row, reason); return true;
    });
  }

  private async finish(session: LiveSession, reason: PreviewStopReason): Promise<void> {
    const row = await this.markStopped(session.id, reason);
    if (!row) return;
    await this.cleanup(row);
  }

  private async cleanup(session: LiveSession, now = Date.now(), ownerPressed = false, counted = true): Promise<void> {
    if (!session.cleanupPending) return;
    // Bounded: an abandoned row asks nothing, and a row inside its
    // back-off waits. Every ask below that ends unconfirmed is counted. The
    // one exception is the owner pressing Run app: one ask per
    // press, which `cleanupMissed` neither counts nor logs again, and the
    // few asks a press makes while its own stop settles (`settleOwnStop`),
    // which pass `counted` false.
    if (!ownerPressed && !cleanupDue(session, now)) return;
    const missed = (row: LiveSession) => (counted ? this.cleanupMissed(row, now) : Promise.resolve());
    let confirmed = false;
    if (!session.runnerId) {
      let owner;
      try { owner = await this.sandbox.lookupAppOwner(session.id); }
      catch { await missed(session); return; }
      if (!owner.found) { await missed(session); return; }
      const adopted = await this.store.change(session.id, row => {
        if (!row.cleanupPending || (row.runnerId && row.runnerId !== owner.runnerId)) return false;
        row.runnerId = owner.runnerId; return true;
      });
      if (!adopted?.cleanupPending || adopted.runnerId !== owner.runnerId) return;
      session = adopted;
      confirmed = owner.cleanupConfirmed;
    }
    if (!confirmed && session.runnerId) {
      await this.sandbox.stopApp(session.runnerId, session.state.stopReason ?? 'learner');
      const answer = await this.sandbox.statusApp(session.runnerId, 0);
      confirmed = ['stopped', 'failed'].includes(answer.status) && answer.cleanupConfirmed === true;
    }
    // No returned runner id is not evidence that a launch never happened.
    // Keep the reservation until the controller can positively reconcile it.
    if (!confirmed) { await missed(session); return; }
    let cleared = false;
    const row = await this.store.change(session.id, fresh => {
      if (!fresh.cleanupPending || fresh.runnerId !== session.runnerId || fresh.revision !== session.revision) return false;
      fresh.cleanupPending = false; fresh.state.forgetAt = now + REMEMBER_MS; cleared = true;
      // A row the bound had marked failed is now confirmed stopped, and reads
      // so: it never was a start that failed.
      if (fresh.state.cleanupAbandonedAt) { fresh.status = 'stopped'; delete fresh.state.cleanupAbandonedAt; }
      return true;
    });
    if (cleared && row && !await this.purgeOrphan(row)) await this.audit('preview.stop', row, { stopReason: row.state.stopReason });
  }

  /**
   * One ask that ended without the runner confirming clean-up.
   *
   * Counted on the row, so the bound holds across replicas and restarts. The
   * last one allowed marks the row failed and says so once, at error level,
   * with what an operator needs: the row, its owner, how long it asked, and
   * that its seat is still reserved.
   */
  private async cleanupMissed(session: LiveSession, now: number): Promise<void> {
    let abandoned: LiveSession | null = null;
    const row = await this.store.change(session.id, fresh => {
      if (!fresh.cleanupPending || fresh.state.cleanupAbandonedAt) return false;
      const attempts = (fresh.state.cleanupAttempts ?? 0) + 1;
      fresh.state.cleanupAttempts = attempts;
      fresh.state.cleanupLastAttemptAt = now;
      if (attempts >= CLEANUP_MAX_ATTEMPTS) {
        fresh.status = 'failed';
        fresh.state.cleanupAbandonedAt = now;
        abandoned = fresh;
      }
      return true;
    });
    if (!abandoned || !row) return;
    const since = Math.round((now - row.state.startedAt) / 60_000);
    this.logger.error(
      `preview clean-up abandoned: session=${row.id} user=${row.userId} phase=${row.phaseStateId} ` +
        `runner=${row.runnerId ?? 'none'} after ${CLEANUP_MAX_ATTEMPTS} attempts (${since} min since start); ` +
        'the runner never confirmed the app stopped, so the row is marked failed and its seat stays reserved. ' +
        'Confirm on the runner host that no preview app runs for this session, then remove the row.',
    );
  }

  private async purgeOrphan(row: LiveSession): Promise<boolean> {
    if (occupies(row)) return false;
    return this.store.transaction(async manager => {
      if (await manager.existsBy(UserEntity, { id: row.userId })) return false;
      const result = await manager.delete(PreviewSessionEntity, { id: row.id, revision: row.revision, cleanupPending: false });
      return !!result.affected;
    });
  }

  private touch(id: string): Promise<LiveSession | null> {
    return this.store.change(id, async (row, manager) => {
      if (!LIVE.includes(row.status)) return false;
      if (!await this.store.current(row, manager)) this.stopped(row, 'learner');
      else if (Date.now() > row.state.expiresAt) this.stopped(row, 'expired');
      else row.state.lastSeenAt = Date.now();
      return true;
    });
  }

  private absorb(session: LiveSession, answer: SandboxAppSession): void {
    if (answer.status === 'unavailable' || answer.status === 'busy') return;
    session.status = answer.status as PreviewStatus;
    session.state.message = answer.message ?? null;
    session.state.stopReason = (answer.stopReason as PreviewStopReason) ?? session.state.stopReason;
    if (answer.bundleOk !== undefined) session.state.bundleOk = answer.bundleOk;
    if (typeof answer.bytesServed === 'number') session.state.bytesServed = answer.bytesServed;
    if (answer.readyAt && !session.state.readyAt) session.state.readyAt = Date.parse(answer.readyAt);
    this.terminalCleanup(session, answer);
  }

  private terminalCleanup(session: LiveSession, answer: SandboxAppSession): void {
    if (LIVE.includes(session.status)) return;
    // A terminal display state (including a missing-runner/404 answer) does not
    // prove process/provider termination. Preserve its evidence while reserving
    // capacity until the trusted runtime explicitly confirms cleanup.
    session.cleanupPending = answer.cleanupConfirmed !== true;
    session.state.forgetAt = Date.now() + REMEMBER_MS;
  }

  /**
   * The view, with `url` only when a capability is being handed over.
   *
   * `url` is the one field that ever carries the capability, and only the
   * answer to a start carries it: a status poll that repeated it would put a
   * live credential into every response body, every browser cache and every
   * HAR file a learner sends us when something goes wrong.
   */
  private view(
    session: LiveSession,
    answer: SandboxAppSession | null,
    capability: string | null,
    workspaceVersion: string | null,
  ): PreviewSessionAnswer {
    const console_ = (answer?.console || []).map(
      (line): PreviewLogLine => ({
        stream: line.stream === 'err' ? 'err' : 'out',
        text: line.text,
        at: line.at,
      }),
    );
    // A seat held by a session the bounded clean-up gave up on:
    // the row reads failed for the operator, and its owner is told what is
    // true, not "Your app did not start", which it may well have.
    const held = heldUnconfirmed(session);
    return {
      id: session.id,
      phaseStateId: session.phaseStateId,
      status: held ? 'unavailable' : session.status,
      url: capability ? `${PREVIEW_DOOR_PREFIX}/${capability}/` : null,
      bundleOk: session.state.bundleOk,
      message: held ? PREVIEW_CLEANUP_HELD_MESSAGE : session.state.message,
      stopReason: session.state.stopReason,
      startedAt: new Date(session.state.startedAt).toISOString(),
      readyAt: session.state.readyAt ? new Date(session.state.readyAt).toISOString() : null,
      expiresAt: new Date(session.state.expiresAt).toISOString(),
      idleExpiresAt: new Date(
        session.state.lastSeenAt + config.previewIdleSeconds * 1000,
      ).toISOString(),
      bytesServed: session.state.bytesServed,
      console: console_,
      cursor: answer?.cursor ?? 0,
      // A row written before the field has none: left out rather than null,
      // so the panel makes no claim about a build it cannot name.
      ...(session.state.builtFromVersion !== undefined ? { builtFromVersion: session.state.builtFromVersion } : {}),
      workspaceVersion,
    };
  }

  /** A deployment that cannot preview at all, said once, with no runner call. */
  private unsupportedView(
    phaseStateId: string,
    unsupported: 'lambda-runner' | 'disabled' | 'isolation' | 'runner',
    detail?: string | null,
  ): PreviewSessionView {
    if (detail) this.logger.warn(`preview refused (${unsupported}): ${detail}`);
    return this.refusedView(
      phaseStateId,
      'unavailable',
      unsupported === 'lambda-runner'
        ? PREVIEW_UNAVAILABLE_MESSAGE
        : unsupported === 'isolation'
          ? PREVIEW_ISOLATION_MESSAGE
          : unsupported === 'runner'
            ? PREVIEW_RUNNER_UNAVAILABLE_MESSAGE
            : PREVIEW_DISABLED_MESSAGE,
    );
  }

  /**
   * A press refused only by the learner's own app: still starting when any of
   * those rows is live (another start of theirs), else still stopping.
   */
  private refuseOwn(phaseStateId: string, own: LiveSession[]): PreviewSessionAnswer {
    return own.some(row => LIVE.includes(row.status))
      ? this.refusedView(phaseStateId, 'busy', PREVIEW_OWN_STARTING_MESSAGE, 'own-preview-starting')
      : this.refusedView(phaseStateId, 'busy', PREVIEW_OWN_STOPPING_MESSAGE, 'own-preview-stopping');
  }

  private refusedView(
    phaseStateId: string,
    status: PreviewStatus,
    message: string,
    reason?: PreviewRefusalReason,
  ): PreviewSessionAnswer {
    const now = new Date().toISOString();
    return {
      id: '',
      phaseStateId,
      status,
      url: null,
      bundleOk: true,
      message,
      stopReason: null,
      startedAt: now,
      readyAt: null,
      expiresAt: now,
      idleExpiresAt: now,
      bytesServed: 0,
      console: [],
      cursor: 0,
      // Absent on every refusal but the learner's own.
      ...(reason ? { reason } : {}),
    };
  }

  /**
   * Two rows a session, never one per proxied request: that is the access
   * log's job, and the capability is redacted out of it (loggablePath).
   */
  private async audit(
    event: 'preview.start' | 'preview.stop',
    session: LiveSession,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.store.transaction(async manager => {
        const owner = await manager.findOne(UserEntity, { where: { id: session.userId }, select: ['id'],
          ...rowLock(this.dataSource, 'pessimistic_read'),
        });
        if (!owner) return;
        await recordAudit(manager, {
          event,
          actorUserId: session.userId,
          subjectUserId: session.userId,
          targetId: session.phaseStateId,
          detail: {
            runnerMode: config.runnerMode,
            bytesServed: session.state.bytesServed,
            ...detail,
          },
        });
      });
    } catch (err) {
      // An audit row is a record, not a gate: losing one must not cost the
      // learner the app they asked for, and the log line above still says it
      // happened.
      this.logger.warn(`preview audit (${event}): ${(err as Error).message}`);
    }
  }
}

/** Exported for the door's own type, which never sees the fields inside it. */
export type { PreviewSessionEntity as PreviewLiveSession };

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf-8').digest();
}
