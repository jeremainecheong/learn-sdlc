'use client';

/**
 * The in-app teacher guide at /teacher/guide.
 *
 * The ten steps, then `docs/teacher-project-upload.md` as the generated module
 * holds it, one section per `##` heading under that heading's own id (so a
 * step's or a refusal's link lands on its section), then every refusal and its
 * fix. Staff only: a learner who lands here is sent home, and the API holds
 * nothing behind this page.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TEACHER_GUIDE_OWN_SECTIONS } from '@learnsdlc/shared';
import { AppShell } from '@/components/AppShell';
import { Markdown } from '@/components/Markdown';
import { Section } from '@/components/ui';
import { useSession } from '@/lib/session';
import { TEACHER_GUIDE_PREAMBLE, TEACHER_GUIDE_SECTIONS } from '@/lib/teacher-guide-doc.generated';
import { GuideRail } from '@/components/staff/guide/GuideRail';
import { RefusalTable } from '@/components/staff/guide/RefusalExplainer';
import { deriveGuideSteps } from '@/components/staff/guide/guide-steps';

export function TeacherGuide() {
  const user = useSession();
  const router = useRouter();
  useEffect(() => {
    if (user?.role === 'LEARNER') router.replace('/dashboard');
  }, [user?.role, router]);

  return (
    <AppShell active="guide" crumbs={[{ label: 'Your classes', href: '/teacher' }, { label: 'Teacher guide' }]}>
      <main id="main" tabIndex={-1} className="mx-auto flex min-w-0 max-w-[900px] flex-col gap-4 p-4 sm:p-6" data-testid="teacher-guide">
        <header className="flex min-w-0 flex-col gap-1">
          <h1 className="h2 wrap">Teacher guide</h1>
          <p className="purpose wrap">
            Everything you do with a project of your own, in order: prepare it, upload it, refine and seal it, check
            it, publish and assign it.
          </p>
        </header>
        <GuideRail steps={deriveGuideSteps({ view: null })} where="guide" stateless title="The ten steps" />
        <article className="flex min-w-0 flex-col gap-4" data-testid="teacher-guide-doc">
          {TEACHER_GUIDE_PREAMBLE && <Markdown>{TEACHER_GUIDE_PREAMBLE}</Markdown>}
          {TEACHER_GUIDE_SECTIONS.map((section) => (
            <section key={section.id} id={section.id} className="min-w-0 scroll-mt-20">
              <Markdown>{section.markdown}</Markdown>
            </section>
          ))}
        </article>
        <Section
          id={TEACHER_GUIDE_OWN_SECTIONS.refusalHelp}
          title="Every refusal, and how to fix it"
          purpose="An upload that is refused imports nothing. Each reason below is what happened, then what to change before you upload again."
          testId="teacher-guide-refusals"
        >
          <RefusalTable />
        </Section>
      </main>
    </AppShell>
  );
}
