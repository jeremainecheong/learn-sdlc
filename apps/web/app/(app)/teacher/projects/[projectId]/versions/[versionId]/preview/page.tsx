'use client';
/**
 * The learner preview's route, beside the editor's own
 * `/teacher/projects/:projectId/versions/:versionId`. Read-only; the entry
 * point is the project editor's Preview button.
 */
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { DocPage } from '@/components/shell';
import { LearnerPreview } from '@/components/staff/preview/LearnerPreview';

export default function TeacherLearnerPreviewPage() {
  const { projectId, versionId } = useParams<{ projectId: string; versionId: string }>();
  if (!projectId || !versionId) {
    return (
      <DocPage title="That project version does not exist">
        <Link href="/teacher/projects">Return to your projects</Link>
      </DocPage>
    );
  }
  return (
    <AppShell active="projects" crumbs={[{ label: 'Projects', href: '/teacher/projects' }, { label: 'Learner preview' }]}>
      <LearnerPreview key={`${projectId}:${versionId}`} projectId={projectId} versionId={versionId} />
    </AppShell>
  );
}
