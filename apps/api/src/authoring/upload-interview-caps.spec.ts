import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { HttpException } from '@nestjs/common';
import {
  INTERVIEW_KEYWORDS_MAX,
  INTERVIEW_KEYWORD_MAX,
  INTERVIEW_LINE_MAX,
  INTERVIEW_MAX_FACTS,
  INTERVIEW_PERSONA_NAME_MAX,
  INTERVIEW_PERSONA_ROLE_MAX,
} from '@learnsdlc/shared';
import { interviewDoorRefusal, refuseInterviewOverCaps } from './interview-caps';
import { checkedInterview } from './authoring-bodies';
import { ContentService } from '../content/content.service';
import type { InterviewBrief, ProjectContent } from '../content/content.types';
import { ProjectImporterService } from '../content/importer.service';
import { MemoryPackSource } from '../content/memory-pack-source';
import { DirectoryPackSource } from '../content/pack-source';
import { layoutFromManifest } from '../content/legacy-layout';
import { UploadService } from './upload.service';
import { writeZip } from '../../test/fixtures/upload-packs/archive';

/*
 * A hand-written
 * interview in an upload is held to the authoring door's caps, the ones
 * `interview.replace` (`checkedInterview`) applies and the loader has none of:
 * the persona's name and role, the three lines, each fact's keyword count, a
 * blank keyword, each keyword's length, and the 24,000-character brief total.
 * A brief over one is refused at the upload door with the door's own sentence,
 * naming the file; a brief within every cap uploads unchanged. The
 * boot import never asks (the platform pack and its content specs are
 * unaffected), and TaskTrackr's own interview is within every cap.
 *
 * Pure: no database, no AI, no server.
 */

function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, 'content', 'tasktrackr', 'project.json'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error('repository root not found');
    dir = up;
  }
  return dir;
}
const REPO = repoRoot();
const SHELF = path.join(REPO, 'apps', 'api', 'test', 'fixtures', 'upload-packs', 'shelf');
/** Shelf exactly as it was, in the older, pointer layout: the one place a phase.json can hold an interview. */
const OLDER_SHELF = path.join(REPO, 'apps', 'api', 'test', 'fixtures', 'older-shelf');
const TASKTRACKR = path.join(REPO, 'content', 'tasktrackr');
const REQ = 'phases/01-requirements';
const FILE = `${REQ}/interview.json`;

function filesUnder(root: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const visit = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      if (entry.isDirectory()) visit(child);
      else out[child] = fs.readFileSync(path.join(root, child));
    }
  };
  visit('');
  return out;
}

const BRIEF: InterviewBrief = {
  persona: { name: 'Mira Tan', role: 'head librarian at the branch library' },
  opening: 'Mira Tan here. Ask me what you need to know.',
  unknownReply: 'I have not decided that yet.',
  refusal: 'That part is your job.',
  maxTurns: 12,
  factsExpected: 2,
  facts: [
    { id: 'f1', topic: 'Who it is for', keywords: ['member'], answer: 'It is for a member.' },
    { id: 'f2', topic: 'What happens to a lent book', keywords: ['loan', 'lent'], answer: 'A lent book is not listed.' },
  ],
};
const fact = (n: number, answer: string) => ({ id: `f${n}`, topic: `Fact ${n}`, keywords: ['shelf'], answer });

/**
 * The over-cap briefs, one per cap of the door, each valid to the loader, with
 * the sentence the door answers, written out word for word.
 */
const OVER: Array<[string, InterviewBrief, string]> = [
  ['a persona name over 80', { ...BRIEF, persona: { ...BRIEF.persona, name: 'N'.repeat(INTERVIEW_PERSONA_NAME_MAX + 1) } }, "The interview persona's name is at most 80 characters, and this one is 81."],
  ['a persona role over 160', { ...BRIEF, persona: { ...BRIEF.persona, role: 'r'.repeat(INTERVIEW_PERSONA_ROLE_MAX + 1) } }, "The interview persona's role is at most 160 characters, and this one is 161."],
  ['an opening over 1,000', { ...BRIEF, opening: 'o'.repeat(INTERVIEW_LINE_MAX + 1) }, "The interview's opening is at most 1000 characters, and this one is 1001."],
  ['a reply to an unknown question over 1,000', { ...BRIEF, unknownReply: 'u'.repeat(INTERVIEW_LINE_MAX + 1) }, "The interview's reply to an unknown question is at most 1000 characters, and this one is 1001."],
  ['a refusal over 1,000', { ...BRIEF, refusal: 'x'.repeat(INTERVIEW_LINE_MAX + 1) }, "The interview's refusal is at most 1000 characters, and this one is 1001."],
  ['a fact with 13 keywords', { ...BRIEF, facts: [{ ...BRIEF.facts[0], keywords: Array.from({ length: INTERVIEW_KEYWORDS_MAX + 1 }, (_v, i) => `word${i}`) }, BRIEF.facts[1]] }, 'The interview\'s fact "f1" has 13 keywords, and a fact takes at most 12.'],
  ['a blank keyword', { ...BRIEF, facts: [{ ...BRIEF.facts[0], keywords: ['member', '   '] }, BRIEF.facts[1]] }, 'The interview\'s fact "f1" has a blank keyword, which would match every question a learner asks.'],
  ['a keyword over 60', { ...BRIEF, facts: [{ ...BRIEF.facts[0], keywords: ['k'.repeat(INTERVIEW_KEYWORD_MAX + 1)] }, BRIEF.facts[1]] }, 'A keyword of the interview\'s fact "f1" is at most 60 characters, and this one is 61.'],
  ['a brief over 24,000 in all, every answer within its cap', { ...BRIEF, factsExpected: 1, facts: Array.from({ length: INTERVIEW_MAX_FACTS }, (_v, i) => fact(i + 1, 'a'.repeat(1_200))) }, 'The interview is 1519 characters longer than one stakeholder can hold; shorten its answers or keywords by at least that much, or keep fewer facts.'],
];

/** The door's sentence for a brief (`checkedInterview`, the interview.replace door), or null when it takes it. */
const doorSays = (brief: InterviewBrief): string | null => {
  try {
    checkedInterview(JSON.parse(JSON.stringify(brief)));
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

const content = new ContentService();
type Files = Record<string, Buffer | string>;
/** Shelf with a hand-written interview: in the folder layout the brief is the Requirements folder's own interview.json. */
const handWritten = (brief: InterviewBrief | string): Files => {
  const text = typeof brief === 'string' ? brief : JSON.stringify(brief, null, 2);
  return { ...filesUnder(SHELF), [FILE]: text };
};
/** The older Shelf with the brief written inline in its Requirements phase.json, as an older archive could hold it. */
const olderInline = (brief: InterviewBrief): Files => {
  const phase = JSON.parse(String(filesUnder(OLDER_SHELF)[`${REQ}/phase.json`]));
  phase.interview = { content: JSON.stringify(brief, null, 2) };
  return { ...filesUnder(OLDER_SHELF), [`${REQ}/phase.json`]: JSON.stringify(phase, null, 2) };
};
const memory = (files: Files): MemoryPackSource =>
  new MemoryPackSource(Object.entries(files).map(([name, data]) => ({ name, bytes: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') })), 'upload', '');
/** The door's reading: an older archive is converted once into the folder layout before the loader reads it. */
const refusal = (files: Files, older = false): string => {
  const source = older ? layoutFromManifest(memory(files)).source : memory(files);
  const loaded = content.loadProject(source);
  try {
    refuseInterviewOverCaps(loaded, source);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('took a brief the door refuses');
};

describe('CAPS: a hand-written interview in an upload is held to the interview door\'s caps', () => {
  it.each(OVER)('%s: refused naming interview.json, with the door\'s own sentence', (_name, brief, sentence) => {
    expect(doorSays(brief)).toBe(sentence);
    expect(interviewDoorRefusal(brief)).toBe(sentence);
    const message = refusal(handWritten(brief));
    expect(message.startsWith(FILE)).toBe(true);
    expect(message.endsWith(sentence)).toBe(true);
  });

  it('an older archive\'s inline brief over a cap, converted once, names the interview.json it became', () => {
    // the folder layout fixes the interview at interview.json, so an inline brief exists only in an older archive
    const message = refusal(olderInline(OVER[0][1]), true);
    expect(message.startsWith(FILE)).toBe(true);
    expect(message).toContain(doorSays(OVER[0][1])!);
  });

  it('a brief within every cap is taken', () => {
    expect(doorSays(BRIEF)).toBeNull();
    expect(interviewDoorRefusal(BRIEF)).toBeNull();
    const source = memory(handWritten(BRIEF));
    const loaded = content.loadProject(source);
    expect(() => refuseInterviewOverCaps(loaded, source)).not.toThrow();
    expect(loaded.phases.find((p) => p.key === 'requirements')?.interview).toEqual(BRIEF);
  });

  it('TaskTrackr\'s own interview is within every cap, so a TaskTrackr copy uploads', () => {
    const source = new DirectoryPackSource(TASKTRACKR);
    const loaded = content.loadProject(source);
    const brief = loaded.phases.find((p) => p.key === 'requirements')!.interview!;
    expect(doorSays(brief)).toBeNull();
    expect(interviewDoorRefusal(brief)).toBeNull();
    expect(() => refuseInterviewOverCaps(loaded, source)).not.toThrow();
  });

  it('the upload door answers NOT_A_PACK, the detail carrying the door\'s sentence; a capped brief reaches the importer', async () => {
    const importer = new ProjectImporterService(content, { transaction: jest.fn(async () => { throw new Error('no database here'); }) } as unknown as DataSource);
    const written: ProjectContent[] = [];
    jest.spyOn(importer as unknown as { writeTeacherDraft: (l: ProjectContent) => Promise<unknown> }, 'writeTeacherDraft').mockImplementation(async (loaded: ProjectContent) => {
      written.push(loaded);
      return { projectId: 'p', versionId: 'v', slug: 'books', report: { ok: true } as never, packDigest: 'd' };
    });
    const upload = new UploadService(importer, content, {} as DataSource, 8 * 1024 * 1024);
    const zip = (files: Files): string =>
      writeZip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data) }))).toString('base64');
    const [, over, sentence] = OVER[1];
    let caught: unknown;
    try {
      await upload.upload({ id: 'owner' } as never, { title: 'Books', archiveBase64: zip(handWritten(over)) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    const body = (caught as HttpException).getResponse() as { code: string; detail?: string };
    expect(body.code).toBe('NOT_A_PACK');
    expect(body.detail).toContain(FILE);
    expect(body.detail).toContain(sentence.replace(/\.$/, ''));
    expect(written).toHaveLength(0);

    const result = await upload.upload({ id: 'owner' } as never, { title: 'Books', archiveBase64: zip(handWritten(BRIEF)) });
    expect(written).toHaveLength(1);
    expect(written[0].phases.find((p) => p.key === 'requirements')?.interview).toEqual(BRIEF);
    expect((result as { interview?: unknown }).interview).toBeUndefined();
  });
});
