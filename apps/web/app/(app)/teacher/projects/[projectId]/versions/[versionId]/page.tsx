'use client';
/**
 * The editor's route. The path mirrors the API's own
 * `/instructor/projects/:projectId/versions/:versionId` under the web's
 * `/teacher` namespace, so a version is addressable and a
 * teacher can keep two drafts open in two tabs.
 */
import { useParams } from 'next/navigation';
import { ProjectEditor } from '@/components/staff/projects/ProjectEditor';
import { DocPage } from '@/components/shell';
import Link from 'next/link';

export default function TeacherProjectVersionPage() {
  const { projectId, versionId } = useParams<{ projectId: string; versionId: string }>();
  if (!projectId || !versionId) {
    return (
      <DocPage title="That project version does not exist">
        <Link href="/teacher/projects">Return to your projects</Link>
      </DocPage>
    );
  }
  return <ProjectEditor key={`${projectId}:${versionId}`} projectId={projectId} versionId={versionId} />;
}
