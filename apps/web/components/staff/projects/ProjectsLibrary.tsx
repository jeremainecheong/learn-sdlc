'use client';

/**
 * The teacher's projects, and the library they may copy or assign.
 *
 * A teacher arrives here owning nothing, and the only way to a project of
 * their own is to **copy one that is already published**. So the empty half of
 * this page is a door rather than an apology, and the platform's own project
 * is drawn as what it is (assignable and copyable, never editable in place)
 * with `platformProjectCopyOnlyRefusal` saying so **before** a teacher clicks
 * rather than after. There is no Edit control on it to grey out.
 *
 * The slug is checked here against `PROJECT_SLUG_PATTERN` before the network
 * is asked, because a round trip to learn that a capital letter is not allowed
 * is a round trip the contract already told us the answer to. Every other
 * refusal is the API's, read back word for word: this page never rewrites a
 * sentence the server wrote.
 *
 * **Every project a teacher owns has a way in.** A project with an open draft
 * opens at the draft; one whose draft has been published opens at the
 * published version, which is read-only and is where the next draft is opened
 * from. A row with neither link would be a project a teacher can see and can
 * never edit again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useRouter } from 'next/navigation';
import type { AuthoredProjectSummary, AuthoringLibraryView } from '@learnsdlc/shared';
import { PROJECT_SLUG_PATTERN, isProjectSlug, platformProjectCopyOnlyRefusal } from '@learnsdlc/shared';
import { AppShell } from '@/components/AppShell';
import { MEASURE, WIDE_PAGE } from '@/components/staff/projects/page-frame';
import { Field } from '@/components/Field';
import { Button, Chip, EmptyState, Notice, Section } from '@/components/ui';
import { describeInstant } from '@/lib/schedule';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { useSession } from '@/lib/session';
import { UploadProject } from '@/components/staff/projects/UploadProject';
import { StartHere } from '@/components/staff/guide/StartHere';
import { DownloadHistory } from '@/components/staff/guide/DownloadHistory';
import { returnFocus, revealForm } from '@/components/staff/projects/reveal-form';

/** Where the editor for a project's open draft lives on the web. */
export function draftHref(projectId: string, versionId: string): string {
  return `/teacher/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`;
}

/** The element inside `box` that carries `testId`, if it is drawn. */
function drawn(box: HTMLElement | null, testId: string): HTMLElement | null {
  return box?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
}

/**
 * Whether the focus is still inside `box`, or nowhere (the body, or nothing).
 *
 * A focus move the person did not just cause (a network answer) is made only
 * when this holds: a teacher who went on to type in another field keeps the
 * caret there.
 */
function focusStillWith(box: HTMLElement | null): boolean {
  const at = document.activeElement;
  return !at || at === document.body || Boolean(box?.contains(at));
}

/** "My project" becomes "my-project", which is what the pattern wants anyway. */
function slugFrom(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * The facts under a library row, as sentences.
 *
 * Not a raw line such as "tasktrackr, 0 classes are on it. Last validated —.",
 * which glues a slug to a count, uses a plural for none and puts a dash where
 * a date is missing.
 */
export function libraryRowLine(row: Pick<AuthoredProjectSummary, 'cohortsUsing' | 'lastValidatedAt'>): string {
  const classes =
    row.cohortsUsing === 0
      ? 'No class is on it yet.'
      : row.cohortsUsing === 1
        ? '1 class is on it.'
        : `${row.cohortsUsing} classes are on it.`;
  const validated = row.lastValidatedAt
    ? `Last validated on ${describeInstant(row.lastValidatedAt)}.`
    : 'Not validated yet.';
  return `${classes} ${validated}`;
}

function ProjectRow({
  row,
  onCopy,
}: {
  row: AuthoredProjectSummary;
  /** Start a copy from this row's published version; `opener` is the row's Copy button, for the focus to come back to. */
  onCopy: (publishedVersionId: string, opener: HTMLElement | null) => void;
}) {
  const actions = useRef<HTMLDivElement>(null);
  const open = row.mine && row.draftVersionId ? draftHref(row.id, row.draftVersionId) : null;
  /**
   * Where the next draft is opened from.
   *
   * A project whose draft has been published carries no `draftVersionId`, so
   * the row above draws no link at all, and the door that opens the next
   * draft lives on the published version's own page. Without this link that
   * page is unreachable and the door with it.
   */
  const openPublished =
    row.mine && !row.draftVersionId && row.publishedVersionId
      ? draftHref(row.id, row.publishedVersionId)
      : null;
  const published = row.publishedVersion
    ? `Published ${row.publishedVersion}`
    : 'Nothing published yet';
  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-b-1.5 border-edge px-4 py-3.5 last:border-b-0"
      data-testid={`projects-row-${row.slug}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">
          {row.title}
        </span>
        {row.isDefault && (
          <Chip tone="accent" testId={`projects-default-${row.slug}`}>
            Default
          </Chip>
        )}
        {row.draftVersion && <Chip tone="warn">Draft {row.draftVersion}</Chip>}
        <Chip tone={row.publishedVersion ? 'pass' : 'outline'}>{published}</Chip>
      </div>
      <p className="label-sm" data-testid={`projects-facts-${row.slug}`}>
        {'Slug '}
        <span className="mono">{row.slug}</span>
        {`. ${libraryRowLine(row)}`}
      </p>
      {row.platformOwned && (
        <p className="purpose wrap" data-testid={`projects-platform-${row.slug}`}>
          {platformProjectCopyOnlyRefusal(row.title)}
        </p>
      )}
      <div ref={actions} className="flex flex-wrap items-center gap-2">
        {open && (
          <Button href={open} size="sm" variant="secondary" testId={`projects-open-${row.slug}`}>
            Open the draft
          </Button>
        )}
        {openPublished && (
          <Button
            href={openPublished}
            size="sm"
            variant="secondary"
            testId={`projects-published-${row.slug}`}
          >
            {`Open version ${row.publishedVersion}`}
          </Button>
        )}
        {row.publishedVersionId && (
          <Button
            size="sm"
            variant={row.isDefault ? 'primary' : 'ghost'}
            icon="copy"
            testId={`projects-copy-${row.slug}`}
            onClick={() =>
              onCopy(
                row.publishedVersionId as string,
                drawn(actions.current, `projects-copy-${row.slug}`),
              )
            }
          >
            Copy into a new project
          </Button>
        )}
      </div>
    </li>
  );
}

export function ProjectsLibrary() {
  const user = useSession();
  const router = useRouter();
  const [view, setView] = useState<AuthoringLibraryView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [openForm, setOpenForm] = useState(false);
  const [source, setSource] = useState('');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  // The Upload project door, opened on request only.
  const [uploadOpen, setUploadOpen] = useState(false);
  const alive = useRef(true);
  /*
   * Both forms are drawn at the head of "Your projects", under the two doors,
   * and each press brings its form into view with the focus in its first field
   * (below a long list, a form opened at its foot would be thousands of pixels
   * down and the press would look dead). Closing gives the focus back to the
   * control that opened the form.
   */
  const doors = useRef<HTMLDivElement>(null);
  const uploadBox = useRef<HTMLDivElement>(null);
  const copyBox = useRef<HTMLDivElement>(null);
  const uploadOpener = useRef<HTMLElement | null>(null);
  const copyOpener = useRef<HTMLElement | null>(null);
  const door = (testId: 'projects-upload-open' | 'projects-new') => drawn(doors.current, testId);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (user?.role === 'LEARNER') router.replace('/dashboard');
  }, [user?.role, router]);

  useEffect(() => {
    projectsApi
      .list()
      .then((next) => {
        if (!alive.current) return;
        setView(next);
        setLoadError('');
      })
      .catch((err) => {
        if (!alive.current) return;
        setLoadError(describeError(err, 'Your projects could not be loaded. Try again in a moment.'));
      });
  }, []);

  /**
   * Open the upload form (a second press finds it again) and show it. The
   * state is committed before the form is looked for, so the focus lands in
   * Title in this same tick.
   */
  const openUpload = () => {
    uploadOpener.current = door('projects-upload-open');
    flushSync(() => setUploadOpen(true));
    revealForm(uploadBox.current, drawn(uploadBox.current, 'projects-upload-title'));
  };

  const closeUpload = () => {
    flushSync(() => setUploadOpen(false));
    returnFocus(uploadOpener.current, door('projects-upload-open'));
  };

  /** Open the copy form from `opener` (New project, or a row's Copy into a new project) and show it. */
  const openCopy = useCallback((opener: HTMLElement | null, versionId?: string) => {
    copyOpener.current = opener;
    flushSync(() => {
      setFormError('');
      if (versionId !== undefined) setSource(versionId);
      setOpenForm(true);
    });
    revealForm(copyBox.current, drawn(copyBox.current, 'projects-new-title'));
  }, []);

  const closeCopy = () => {
    flushSync(() => setOpenForm(false));
    returnFocus(copyOpener.current, door('projects-new'));
  };

  // An accepted upload that stays on this page shows in the list at once.
  const refreshList = () => {
    projectsApi
      .list()
      .then((next) => {
        if (alive.current) setView(next);
      })
      // A failed read keeps the list on screen as it was; the upload's own receipt already says it landed.
      .catch(() => undefined);
  };

  /** Every version a teacher may copy: the library's, and their own published ones. */
  const copyable = useMemo(() => {
    const rows = [...(view?.library ?? []), ...(view?.mine ?? [])];
    return rows.filter((row) => row.publishedVersionId !== null);
  }, [view]);

  const startCopy = useCallback(
    (versionId: string, opener: HTMLElement | null) => openCopy(opener, versionId),
    [openCopy],
  );

  // The default is what a teacher copies unless they say otherwise.
  useEffect(() => {
    if (source || copyable.length === 0) return;
    const fallback = copyable.find((row) => row.isDefault) ?? copyable[0];
    setSource(fallback.publishedVersionId ?? '');
  }, [copyable, source]);

  const editTitle = (value: string) => {
    setFormError('');
    setTitle(value);
    if (!slugTouched) setSlug(slugFrom(value));
  };

  const submit = async () => {
    const wantedTitle = title.trim();
    const wantedSlug = slug.trim();
    if (!wantedTitle) {
      setFormError('Give the project a title, which is the name a class sees.');
      return;
    }
    if (!isProjectSlug(wantedSlug)) {
      setFormError(
        'A slug is lower case, opens on a letter and holds letters, digits and hyphens, so that it can be part of a web address. Try "my-course".',
      );
      return;
    }
    if (!source) {
      setFormError('Choose the published project to copy. A new project starts as a copy of one.');
      return;
    }
    setBusy(true);
    setFormError('');
    try {
      const made = await projectsApi.create({
        title: wantedTitle,
        slug: wantedSlug,
        fromVersionId: source,
      });
      if (!alive.current) return;
      router.push(draftHref(made.project.id, made.draftVersionId));
    } catch (err) {
      if (alive.current) {
        setFormError(
          describeError(err, 'The project could not be created. Try again in a moment.'),
        );
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const mine = view?.mine ?? [];
  const library = view?.library ?? [];

  return (
    <AppShell active="projects" crumbs={[{ label: 'Your classes', href: '/teacher' }, { label: 'Projects' }]}>
      {/* The class pages' width and left edge. */}
      <main id="main" tabIndex={-1} className={WIDE_PAGE} data-testid="projects-page">
        <header className="flex min-w-0 flex-col gap-1">
          <h1 className="h2 wrap">Projects</h1>
          <p className={`purpose wrap ${MEASURE}`}>
            A project is the phases a class works through: LearnSDLC has six, and a project holds the
            ones its teacher chose. Copy one that is published, edit your copy, publish a version and
            assign that version to a class.
          </p>
        </header>

        {loadError && (
          <Notice tone="fail" role="alert" testId="projects-error">
            {loadError}
          </Notice>
        )}

        {/* On a wide screen, the path on the left and the projects on the right: two columns of
            independent cards. Narrower, one column in the same order. */}
        <div className="grid min-w-0 items-start gap-4 xl:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            {/* Start here. */}
            <StartHere />
            {/* Which of the archives above this teacher has downloaded; nothing on a failed read. */}
            <DownloadHistory />
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <Section
              title="Your projects"
              purpose="Projects you made. Only these are yours to edit."
              testId="projects-list"
              id="guide-upload"
              pad={false}
              right={
                <div ref={doors} className="flex flex-wrap items-center gap-2">
                  {/* The Upload project door. */}
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="upload"
                    testId="projects-upload-open"
                    onClick={openUpload}
                  >
                    Upload a project
                  </Button>
                  <Button
                    size="sm"
                    icon="plus"
                    testId="projects-new"
                    onClick={() => openCopy(door('projects-new'))}
                  >
                    New project
                  </Button>
                </div>
              }
            >
              {/* The forms open here, under the doors that open them; with neither open the list is all
                  this section holds. Its profile is read when the upload form opens, not with the page. */}
              {uploadOpen && (
                <div ref={uploadBox} className="scroll-mt-4 scroll-mb-4 px-4">
                  <UploadProject
                    onClose={closeUpload}
                    onUploaded={() => {
                      refreshList();
                      // A finished upload that stays on the page: the focus goes back to its door, but only
                      // from the upload form or from nowhere. The answer comes from the network, so the teacher
                      // may be typing in the copy form by then, and the caret stays where they put it.
                      if (focusStillWith(uploadBox.current)) {
                        returnFocus(uploadOpener.current, door('projects-upload-open'));
                      }
                    }}
                  />
                </div>
              )}
              {openForm && (
                <div ref={copyBox} className="scroll-mt-4 scroll-mb-4 px-4">
                  <Section
                    title="New project, from a copy"
                    purpose="Every project starts as a copy of a published one, so a new project is never empty."
                    testId="projects-new-form"
                  >
                    {formError && (
                      <Notice tone="fail" role="alert" testId="projects-new-error">
                        {formError}
                      </Notice>
                    )}
                    <div className="flex min-w-0 flex-col gap-3">
                      <Field
                        id="projects-new-title"
                        label="Title"
                        hint="What a class sees. You can change it later."
                        value={title}
                        data-testid="projects-new-title"
                        onChange={(e) => editTitle(e.target.value)}
                      />
                      <Field
                        id="projects-new-slug"
                        label="Slug"
                        hint='Lower case, opening on a letter: "my-course". It is part of the web address and it does not change.'
                        value={slug}
                        pattern={PROJECT_SLUG_PATTERN.source}
                        data-testid="projects-new-slug"
                        onChange={(e) => {
                          setSlugTouched(true);
                          setFormError('');
                          setSlug(e.target.value);
                        }}
                      />
                      <label className="min-w-0" htmlFor="projects-new-source">
                        <span className="block text-[13px] font-medium text-ink">Copy from</span>
                        <select
                          id="projects-new-source"
                          className="field mt-1.5"
                          data-testid="projects-new-source"
                          value={source}
                          onChange={(e) => {
                            setFormError('');
                            setSource(e.target.value);
                          }}
                        >
                          {copyable.map((row) => (
                            <option key={row.publishedVersionId ?? row.id} value={row.publishedVersionId ?? ''}>
                              {`${row.title} ${row.publishedVersion ?? ''}`.trim()}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="flex flex-wrap items-center gap-2.5">
                      <Button onClick={submit} busy={busy} busyLabel="Copying…" testId="projects-new-submit">
                        Create the project
                      </Button>
                      <Button variant="ghost" onClick={closeCopy} testId="projects-new-cancel">
                        Cancel
                      </Button>
                      <span className="label-sm">
                        The copy opens as draft 0.1.0. Nothing reaches a class until you publish a version and
                        assign it.
                      </span>
                    </div>
                  </Section>
                </div>
              )}
              {view === null ? (
                <div className="flex flex-col gap-2.5 px-4 pb-4">
                  <p className="purpose" data-testid="projects-loading">
                    Loading your projects.
                  </p>
                  <div className="flex flex-col gap-2" aria-hidden="true">
                    <div className="skeleton h-10 w-full" />
                    <div className="skeleton h-10 w-full" />
                  </div>
                </div>
              ) : mine.length === 0 ? (
                <div className="px-4 pb-4">
                  <EmptyState
                    icon="layers"
                    title="No projects of your own yet"
                    body="Copy a published project from the library below. The copy is yours: its tasks, its briefs and its rules are all editable, and the original is untouched."
                    testId="projects-empty"
                  />
                </div>
              ) : (
                <ul className="m-0 flex list-none flex-col p-0">
                  {mine.map((row) => (
                    <ProjectRow key={row.id} row={row} onCopy={startCopy} />
                  ))}
                </ul>
              )}
            </Section>

            <Section
              title="The library"
              purpose="Published projects you can assign to a class as they stand, or copy and edit."
              testId="projects-library"
              pad={false}
            >
              {library.length === 0 ? (
                <div className="px-4 pb-4">
                  <EmptyState
                    icon="layers"
                    title="The library is empty"
                    body="Nothing is published for this deployment yet."
                    testId="projects-library-empty"
                  />
                </div>
              ) : (
                <ul className="m-0 flex list-none flex-col p-0">
                  {library.map((row) => (
                    <ProjectRow key={row.id} row={row} onCopy={startCopy} />
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
