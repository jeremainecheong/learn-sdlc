'use client';

/**
 * The signed-in half of the app.
 *
 * Every page under this group is drawn inside one shell, and the shell is
 * built here: above the router, so it outlives every navigation. The route
 * group is invisible in the URL: `/dashboard` is still `/dashboard`.
 *
 * Three things wrap the frame, in this order. {@link SessionGate} turns a
 * visitor without a token away before anything is drawn. {@link ProjectProvider}
 * loads the enrolment once and holds it, so a page mount is not a reason to
 * fetch. {@link ShellProvider} carries what each page declares about the
 * chrome (its breadcrumbs, which entry is lit, the sidebar's width) and the
 * frame reads both.
 */
// Three files rather than the shell's barrel, deliberately. The barrel also
// exports the reviewer's column, the palette, the IDE parts and the coach
// marks, and none of them can be shaken out: several have module-level side
// effects, so importing it here put all of that, a 143 KB markdown engine
// included, into the floor of every signed-in page. The account page,
// the class-code page and the admin console draw none of it.
import { AppFrame, SessionGate } from '@/components/shell/AppFrame';
import { ShellProvider } from '@/components/shell/ShellProvider';
import { ProjectProvider } from '@/lib/useProject';
import { useSession } from '@/lib/session';
import { useEffect, useState } from 'react';
import { useProject } from '@/lib/useProject';
import { SessionEntry } from '@/components/shell/SessionEntry';

function ProjectEntry({ children }: { children: React.ReactNode }) {
  const project = useProject();
  const [opened, setOpened] = useState(!project.loading);
  useEffect(() => { if (!project.loading) setOpened(true); }, [project.loading]);
  // Only initial entry waits here. Background refresh and switching projects
  // keep the existing shell, including its focus and navigation preferences.
  if (!opened && project.loading) return <SessionEntry label="Opening your project…" testId="project-entry" />;
  return children;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const session = useSession();
  return (
    <SessionGate>
      <ProjectProvider key={session?.id ?? 'signed-out'}>
        <ProjectEntry>
        <ShellProvider>
          <AppFrame>{children}</AppFrame>
        </ShellProvider>
        </ProjectEntry>
      </ProjectProvider>
    </SessionGate>
  );
}
