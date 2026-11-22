// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STORY_FLOOR, type PhaseDetail } from '@learnsdlc/shared';
import type { PhasePanelProps } from '@/components/workspace/panels/types';

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('@/lib/scenario', async (original) => ({ ...(await original<typeof import('@/lib/scenario')>()), useReferenceScaffolding: () => false }));

import RequirementsBrief from '@/components/workspace/panels/requirements/BriefCard';
import IssueEditor from '@/components/workspace/panels/requirements/IssueEditor';

const SENTENCE = "This project's Requirements task is in an older format; its owner needs to re-save it.";
const props = (story?: PhaseDetail['story']) => ({
  detail: { id: 'p1', key: 'requirements', status: 'in_progress', files: [], ...(story ? { story } : {}) } as unknown as PhaseDetail,
  helpers: { fileText: () => '' },
}) as unknown as PhasePanelProps;

describe('the IDE Requirements panels on a phase with no story spec', () => {
  it.each([['the brief card', RequirementsBrief], ['the Issue rail', IssueEditor]] as const)('%s says only the older-format sentence', (_name, Panel) => {
    const markup = renderToStaticMarkup(<Panel {...props()} />);
    expect(markup).toContain(SENTENCE.replace("'", '&#x27;'));
    expect(markup).not.toContain('Story checks');
  });

  it.each([['the brief card', RequirementsBrief], ['the Issue rail', IssueEditor]] as const)('%s draws the checks once the phase has one', (_name, Panel) => {
    const markup = renderToStaticMarkup(<Panel {...props({ id: 'SH-5', hints: {}, floor: DEFAULT_STORY_FLOOR, providedStories: [] })} />);
    expect(markup).not.toContain('older format');
    expect(markup).toContain('Story checks');
  });
});
