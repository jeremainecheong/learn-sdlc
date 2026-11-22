'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Role, UserProfile } from '@learnsdlc/shared';
import { PASSWORD_MIN_LENGTH } from '@learnsdlc/shared';
import { describeError, getStoredUser, getToken, request, signInHref } from '@/lib/api';
import { adminApi, type AdminCohort, type AdminUser } from '@/lib/api-admin';
import { formatJoinCode } from '@/lib/api-cohorts';
import { Field } from '@/components/Field';
import { Icon } from '@/components/Icon';
import { AppShell } from '@/components/AppShell';
import { Chip, Notice, Section } from '@/components/ui';
import { sentence, when } from '@/components/staff/primitives';

const ROLES: Role[] = ['LEARNER', 'INSTRUCTOR', 'ADMIN'];
const DEFAULT_COHORT = 'default';

const roleWord = (role: Role) => sentence(role.toLowerCase());

/**
 * Which block the answer belongs to.
 *
 * The console is six blocks tall, so a notice at the top of it would show
 * "every session they had is signed out" a screen and a half above the button
 * that did it. An answer renders in the block that produced it instead.
 * 'page' is the one that belongs to no block: the class list is read on mount,
 * before there is a block to put it in.
 */
type Scope = 'page' | 'search' | 'role' | 'password' | 'classes' | 'suspend';

interface Answer {
  scope: Scope;
  tone: 'pass' | 'fail';
  text: string;
}

function BlockNotice({ answer, scope }: { answer: Answer | null; scope: Scope }) {
  if (!answer || answer.scope !== scope) return null;
  return (
    <Notice
      tone={answer.tone}
      role={answer.tone === 'fail' ? 'alert' : 'status'}
      testId={answer.tone === 'fail' ? 'admin-error' : 'admin-note'}
    >
      {answer.text}
    </Notice>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [me, setMe] = useState<UserProfile | null>(null);
  const [cohorts, setCohorts] = useState<AdminCohort[]>([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<AdminUser | null>(null);
  const [role, setRole] = useState<Role>('LEARNER');
  const [cohort, setCohort] = useState(DEFAULT_COHORT);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'idle' | 'saving' | 'suspending' | 'password' | 'owner'>('idle');
  /** Which class is being moved, so only that row's button says so. */
  const [moving, setMoving] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (!getToken()) {
      {
      // The sign-in page, told where the learner was, and nothing at all when
      // the session has just ended, because `request()` is already navigating
      // there with the reason as well.
      const to = signInHref();
      if (to) router.replace(to);
    };
      return;
    }
    const stored = getStoredUser();
    if (stored && stored.role !== 'ADMIN') {
      router.replace(stored.role === 'INSTRUCTOR' ? '/instructor' : '/dashboard');
      return;
    }
    setMe(stored);
    adminApi
      .cohorts()
      .then(setCohorts)
      .catch((err) =>
        setAnswer({
          scope: 'page',
          tone: 'fail',
          text: describeError(err, 'The classes could not be loaded. Try again in a moment.'),
        }),
      );
  }, [router]);

  /** The edit form always mirrors the row as last read, so a stale draft cannot be saved. */
  const show = (user: AdminUser) => {
    setFound(user);
    setRole(user.role);
    setCohort(user.cohort);
  };

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearching(true);
    setAnswer(null);
    setFound(null);
    try {
      show(await adminApi.lookup(query));
    } catch (err) {
      setAnswer({
        scope: 'search',
        tone: 'fail',
        text: describeError(err, 'That account could not be looked up. Check the address and try again.'),
      });
    } finally {
      setSearching(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!found) return;
    setBusy('saving');
    setAnswer(null);
    try {
      show(await adminApi.update(found.id, { role, cohort }));
      setAnswer({ scope: 'role', tone: 'pass', text: 'Saved. The change applies to their next request.' });
    } catch (err) {
      setAnswer({
        scope: 'role',
        tone: 'fail',
        text: describeError(err, 'The change could not be saved. Try again in a moment.'),
      });
    } finally {
      setBusy('idle');
    }
  };

  const setSuspended = async (disabled: boolean) => {
    if (!found) return;
    setBusy('suspending');
    setAnswer(null);
    try {
      show(await adminApi.update(found.id, { disabled }));
      setAnswer({
        scope: 'suspend',
        tone: 'pass',
        text: disabled
          ? 'Suspended. Every session they had is signed out.'
          : 'Restored. They can sign in again.',
      });
    } catch (err) {
      setAnswer({
        scope: 'suspend',
        tone: 'fail',
        text: describeError(err, 'The account could not be updated. Try again in a moment.'),
      });
    } finally {
      setBusy('idle');
    }
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!found) return;
    setBusy('password');
    setAnswer(null);
    try {
      await adminApi.setPassword(found.id, password);
      setPassword('');
      setAnswer({
        scope: 'password',
        tone: 'pass',
        text: 'Password set. Every session they had is signed out; give them the new one directly.',
      });
    } catch (err) {
      setAnswer({
        scope: 'password',
        tone: 'fail',
        text: describeError(err, 'The password could not be set. Try again in a moment.'),
      });
    } finally {
      setBusy('idle');
    }
  };

  /**
   * Move a class to the account on screen.
   *
   * The one repair for a class whose owner has left: scope resolves through
   * cohorts.ownerUserId, so a class with a dangling owner is invisible to
   * every instructor while its join code keeps working. It is also the way
   * past the refusal an instructor meets when they try to delete an account
   * that still owns a class with learners in it.
   *
   * The call is written here rather than in lib/api-admin.ts; this page is
   * its only caller.
   */
  const moveClass = async (cohortId: string) => {
    if (!found) return;
    setBusy('owner');
    setMoving(cohortId);
    setAnswer(null);
    try {
      const updated = await request<AdminCohort>(
        'PATCH',
        `/admin/cohorts/${encodeURIComponent(cohortId)}/owner`,
        { ownerUserId: found.id },
      );
      setCohorts((list) => list.map((c) => (c.id === updated.id ? updated : c)));
      setAnswer({
        scope: 'classes',
        tone: 'pass',
        text: `${updated.name} is now ${found.displayName}'s class. The join code did not change.`,
      });
    } catch (err) {
      setAnswer({
        scope: 'classes',
        tone: 'fail',
        text: describeError(err, 'The class could not be moved. Try again in a moment.'),
      });
    } finally {
      setBusy('idle');
      setMoving('');
    }
  };

  const isSelf = Boolean(found && me && found.id === me.id);
  const dirty = Boolean(found && (role !== found.role || cohort !== found.cohort));
  const cohortLabel = (c: AdminCohort) =>
    `${c.name}, code ${formatJoinCode(c.joinCode)}${c.ownerEmail ? `, ${c.ownerEmail}` : ''}`;
  // A cohort the row points at but the list does not know (deleted, or read
  // before the list loaded) still has to be selectable, or the form would
  // silently move the account to 'default' on the next save.
  const unknownCohort = found && found.cohort !== DEFAULT_COHORT && !cohorts.some((c) => c.id === found.cohort);
  const suspended = Boolean(found?.disabledAt);
  /** Only staff may hold a class; the API refuses a learner and says so. */
  const canOwnClasses = Boolean(found && found.role !== 'LEARNER' && !found.disabledAt);

  return (
    <AppShell active="accounts" crumbs={[{ label: 'Accounts' }]}>
      <main id="main" tabIndex={-1} className="mx-auto flex max-w-[760px] min-w-0 flex-col gap-4 px-4 py-6 sm:px-6">
        <div className="min-w-0">
          <h1 className="h1" data-testid="admin-title">
            Accounts
          </h1>
          <p className="purpose mt-1">
            Find an account by its email address to change its role or class, suspend it, or set a new
            password for someone locked out.
          </p>
        </div>

        <BlockNotice answer={answer} scope="page" />

        <Section title="Find an account" purpose="Search by the email address they signed up with." icon="search">
          <form onSubmit={search} className="flex flex-wrap items-end gap-2.5">
            <div className="min-w-[200px] flex-1">
              <Field
                id="admin-email"
                label="Email"
                type="email"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                required
                data-testid="admin-email"
              />
            </div>
            <button type="submit" disabled={searching || !query.trim()} className="btn" data-testid="admin-search">
              {searching ? 'Looking…' : 'Find'}
            </button>
          </form>
          <BlockNotice answer={answer} scope="search" />
        </Section>

        {found && (
          <>
            <Section
              title={found.displayName}
              purpose={suspended ? 'This account cannot sign in until it is restored.' : 'This account can sign in.'}
              icon="user"
              testId="admin-user"
              right={
                <span className="flex flex-wrap items-center justify-end gap-1.5">
                  <Chip tone="accent">{roleWord(found.role)}</Chip>
                  <Chip tone={suspended ? 'fail' : 'pass'} testId="admin-status">
                    {suspended ? 'Suspended' : 'Active'}
                  </Chip>
                </span>
              }
            >
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="label">Email</dt>
                  <dd className="verbatim wrap mt-1 text-ink">{found.email}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="label">Role</dt>
                  <dd className="mt-1 text-[13.5px] text-ink" data-testid="admin-user-role">
                    {roleWord(found.role)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="label">Class</dt>
                  <dd className="wrap mt-1 text-[13.5px] text-ink" data-testid="admin-user-cohort">
                    {found.cohort === DEFAULT_COHORT ? 'None' : found.cohortName || found.cohort}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="label">{suspended ? 'Suspended since' : 'Joined'}</dt>
                  <dd className="mt-1 text-[13.5px] tabular-nums text-ink">
                    {when(found.disabledAt || found.createdAt)}
                  </dd>
                </div>
              </dl>
            </Section>

            <Section
              title="Role and class"
              purpose="An instructor sees the learners in their own class; an admin sees everyone. Moving a learner changes which instructor sees them."
            >
              <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
                <div className="min-w-0">
                  <label htmlFor="admin-role" className="block text-[13.5px] font-medium text-ink">
                    Role
                  </label>
                  <select
                    id="admin-role"
                    className="field mt-1.5"
                    value={role}
                    disabled={isSelf}
                    onChange={(e) => setRole(e.target.value as Role)}
                    data-testid="admin-role"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {roleWord(r)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-0">
                  <label htmlFor="admin-cohort" className="block text-[13.5px] font-medium text-ink">
                    Class
                  </label>
                  <select
                    id="admin-cohort"
                    className="field mt-1.5"
                    value={cohort}
                    onChange={(e) => setCohort(e.target.value)}
                    data-testid="admin-cohort"
                  >
                    <option value={DEFAULT_COHORT}>None</option>
                    {unknownCohort && <option value={found.cohort}>{found.cohortName || found.cohort}</option>}
                    {cohorts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {cohortLabel(c)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                  <button type="submit" disabled={busy !== 'idle' || !dirty} className="btn" data-testid="admin-save">
                    {busy === 'saving' ? 'Saving…' : 'Save'}
                  </button>
                  {isSelf && <span className="label">You cannot change your own role.</span>}
                </div>
              </form>
              <BlockNotice answer={answer} scope="role" />
            </Section>

            <Section
              title="Set a password"
              purpose="For someone who has lost theirs. Signs out every session they had; hand them the new password directly and ask them to change it from their account page."
            >
              {isSelf ? (
                <p className="text-[13px] text-muted">
                  Change your own password from your account page. That route checks your current one
                  first.
                </p>
              ) : (
                <form onSubmit={savePassword} className="flex flex-wrap items-end gap-2.5">
                  <div className="min-w-[200px] flex-1">
                    <Field
                      id="admin-password"
                      label="New password"
                      type="password"
                      autoComplete="new-password"
                      hint={`At least ${PASSWORD_MIN_LENGTH} characters, and not one of the common breached passwords.`}
                      minLength={PASSWORD_MIN_LENGTH}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      data-testid="admin-password"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busy !== 'idle' || password.length < PASSWORD_MIN_LENGTH}
                    className="btn"
                    data-testid="admin-password-save"
                  >
                    {busy === 'password' ? 'Setting…' : 'Set password'}
                  </button>
                </form>
              )}
              <BlockNotice answer={answer} scope="password" />
            </Section>

            <Section
              title="Classes"
              purpose={
                canOwnClasses
                  ? 'Move a class to this account. The learners in it come with it and the join code stays the same. An account that still owns a class with people in it cannot be deleted until somebody else owns it.'
                  : 'A class can only be owned by an instructor or an admin. Change the role above to move one here.'
              }
              testId="admin-classes"
            >
              {cohorts.length === 0 ? (
                <p className="text-[13px] text-muted">No classes have been made yet.</p>
              ) : (
                <ul className="flex flex-col gap-2" data-testid="admin-class-list">
                  {cohorts.map((c) => {
                    const theirs = c.ownerUserId === found.id;
                    return (
                      <li
                        key={c.id}
                        className="flex flex-wrap items-center justify-between gap-2 border-b-1.5 border-edge pb-2 last:border-b-0 last:pb-0"
                      >
                        <div className="min-w-0">
                          <p className="wrap text-[13.5px] text-ink">{c.name}</p>
                          <p className="wrap text-[12.5px] text-muted">
                            {c.memberCount} learner{c.memberCount === 1 ? '' : 's'}, code{' '}
                            {formatJoinCode(c.joinCode)},{' '}
                            {c.ownerEmail ? `owned by ${c.ownerEmail}` : 'owner account is gone'}
                          </p>
                        </div>
                        {theirs ? (
                          <Chip tone="pass">Theirs</Chip>
                        ) : (
                          <button
                            type="button"
                            onClick={() => moveClass(c.id)}
                            disabled={busy !== 'idle' || !canOwnClasses}
                            className="btn-secondary"
                            data-testid={`admin-class-move-${c.id}`}
                          >
                            {busy === 'owner' && moving === c.id ? 'Moving…' : 'Move here'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <BlockNotice answer={answer} scope="classes" />
            </Section>

            <Section
              title={suspended ? 'Restore access' : 'Suspend'}
              purpose={
                suspended
                  ? 'Lets them sign in again. Nothing of theirs was removed while suspended.'
                  : 'Signs them out everywhere and refuses every sign-in until restored. Their work is kept.'
              }
              className={suspended ? '' : 'border-fail/40'}
            >
              {isSelf ? (
                <p className="text-[13px] text-muted">You cannot suspend your own account.</p>
              ) : suspended ? (
                <div>
                  <button
                    type="button"
                    onClick={() => setSuspended(false)}
                    disabled={busy !== 'idle'}
                    className="btn-secondary"
                    data-testid="admin-restore"
                  >
                    <Icon name="check-circle" size={15} className="text-pass" />
                    {busy === 'suspending' ? 'Restoring…' : 'Restore access'}
                  </button>
                </div>
              ) : (
                <div>
                  <button
                    type="button"
                    onClick={() => setSuspended(true)}
                    disabled={busy !== 'idle'}
                    className="btn-secondary text-fail"
                    data-testid="admin-suspend"
                  >
                    <Icon name="warning" size={15} />
                    {busy === 'suspending' ? 'Suspending…' : 'Suspend this account'}
                  </button>
                </div>
              )}
              <BlockNotice answer={answer} scope="suspend" />
            </Section>
          </>
        )}
      </main>
    </AppShell>
  );
}
