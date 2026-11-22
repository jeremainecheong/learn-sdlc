'use client';

/**
 * "Start here" on the Projects page.
 *
 * The two archives a teacher can start from, served to staff only by
 * `GET /instructor/starter/:name`, the starter's warning,
 * the ten steps without state, and the way into the full guide. A download is
 * one read; its refusal is said in the API's words.
 */
import { useState } from 'react';
import Link from 'next/link';
import { STARTER_ARCHIVES, STARTER_WARNING, TEACHER_GUIDE_PATH, type StarterArchiveName } from '@learnsdlc/shared';
import { Button, Notice, Section } from '@/components/ui';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { saveBlob } from '@/lib/download';
import { GuideRail } from '@/components/staff/guide/GuideRail';
import { deriveGuideSteps } from '@/components/staff/guide/guide-steps';

/** What each archive is called on the button and in the browser's downloads (the API's Content-Disposition names). */
export const STARTER_DOWNLOADS: Record<StarterArchiveName, { label: string; file: string; line: string }> = {
  starter: {
    label: 'Download the starter',
    file: 'learnsdlc-starter.zip',
    line: 'A small project in the authoring layout, with a note in every phase and a stakeholder interview for its Requirements phase.',
  },
  shelf: {
    label: 'Download the shelf example',
    file: 'learnsdlc-shelf.zip',
    line: 'A finished example project to read beside the starter.',
  },
};

export function StartHere() {
  const [busy, setBusy] = useState<StarterArchiveName | ''>('');
  const [error, setError] = useState('');
  const download = async (name: StarterArchiveName) => {
    setBusy(name);
    setError('');
    try {
      const { blob } = await projectsApi.starterArchive(name);
      saveBlob(blob, STARTER_DOWNLOADS[name].file);
    } catch (err) {
      setError(describeError(err, 'The archive could not be downloaded. Try again in a moment.'));
    } finally {
      setBusy('');
    }
  };
  return (
    <Section
      id="guide-start-here"
      title="Start here"
      purpose="Download the starter, upload it as a draft and walk it through the ten steps below. The teacher guide has the whole of it."
      testId="guide-start-here"
    >
      {error && (
        <Notice tone="fail" role="alert" testId="guide-starter-error">
          {error}
        </Notice>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {STARTER_ARCHIVES.map((name) => (
          <li key={name} className="flex min-w-0 flex-wrap items-center gap-2.5">
            <Button
              size="sm"
              variant="secondary"
              icon="download"
              busy={busy === name}
              busyLabel="Downloading…"
              testId={`guide-starter-${name}`}
              onClick={() => void download(name)}
            >
              {STARTER_DOWNLOADS[name].label}
            </Button>
            <span className="purpose wrap min-w-0 flex-1">{STARTER_DOWNLOADS[name].line}</span>
          </li>
        ))}
      </ul>
      <Notice tone="warn" role="note" testId="guide-starter-warning">
        {STARTER_WARNING}
      </Notice>
      <GuideRail steps={deriveGuideSteps({ view: null })} where="projects" stateless title="The ten steps" testId="guide-rail-projects" />
      <p className="text-[13px]">
        <Link href={TEACHER_GUIDE_PATH} className="underline" data-testid="guide-open">
          Open the teacher guide
        </Link>
      </p>
    </Section>
  );
}
