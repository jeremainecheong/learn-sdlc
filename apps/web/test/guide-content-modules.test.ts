/**
 * The guides' words live in one module per phase, under
 * `components/learn/content/` and `components/learn/study/`, and
 * `content.ts` and `study.ts` are their indexes.
 *
 * The indexes export `LESSONS` and `PHASE_STUDY`, nothing else at runtime,
 * each entry is the phase module's own object, and every guide keeps its
 * shape (four chapters, three options, four walkthroughs).
 */
import { describe, expect, it } from 'vitest';
import * as content from '@/components/learn/content';
import * as study from '@/components/learn/study';
import { REQUIREMENTS_LESSON } from '@/components/learn/content/requirements';
import { DESIGN_LESSON } from '@/components/learn/content/design';
import { IMPLEMENTATION_LESSON } from '@/components/learn/content/implementation';
import { TESTING_LESSON } from '@/components/learn/content/testing';
import { DEPLOYMENT_LESSON } from '@/components/learn/content/deployment';
import { MAINTENANCE_LESSON } from '@/components/learn/content/maintenance';
import { REQUIREMENTS_STUDY } from '@/components/learn/study/requirements';
import { DESIGN_STUDY } from '@/components/learn/study/design';
import { IMPLEMENTATION_STUDY } from '@/components/learn/study/implementation';
import { TESTING_STUDY } from '@/components/learn/study/testing';
import { DEPLOYMENT_STUDY } from '@/components/learn/study/deployment';
import { MAINTENANCE_STUDY } from '@/components/learn/study/maintenance';

const PHASES = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
const MODULES = {
  requirements: [REQUIREMENTS_LESSON, REQUIREMENTS_STUDY],
  design: [DESIGN_LESSON, DESIGN_STUDY],
  implementation: [IMPLEMENTATION_LESSON, IMPLEMENTATION_STUDY],
  testing: [TESTING_LESSON, TESTING_STUDY],
  deployment: [DEPLOYMENT_LESSON, DEPLOYMENT_STUDY],
  maintenance: [MAINTENANCE_LESSON, MAINTENANCE_STUDY],
} as const;

describe('the guides split one module per phase', () => {
  it('keeps exactly the runtime exports the two files had', () => {
    expect(Object.keys(content).sort()).toEqual(['LESSONS']);
    expect(Object.keys(study).sort()).toEqual(['PHASE_STUDY']);
    expect(Object.keys(content.LESSONS)).toEqual([...PHASES]);
    expect(Object.keys(study.PHASE_STUDY)).toEqual([...PHASES]);
  });

  it('serves each phase from its own module, in the same shape', () => {
    for (const phase of PHASES) {
      const [lesson, phaseStudy] = MODULES[phase];
      expect(content.LESSONS[phase]).toBe(lesson);
      expect(study.PHASE_STUDY[phase]).toBe(phaseStudy);
      expect(lesson.chapters).toHaveLength(4);
      expect(phaseStudy.chapters).toHaveLength(4);
      for (const chapter of lesson.chapters) expect(chapter.options).toHaveLength(3);
    }
  });
});
