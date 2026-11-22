/* Every guide ends with "Watch the idea in practice".
 *
 * The Requirements and Testing guides had a video row and four guides had
 * none. Each of the six now lists videos, and the reader draws a poster from a local file
 * (`/lessons/video-<id>.jpg`), never from YouTube, so a video with no poster
 * file would draw a broken image. These tests pin: a row on every guide, a
 * poster file for every video, and a record of where each poster came from. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LESSONS } from '@/components/learn/content';

const PHASES = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
const lessonsDir = resolve(__dirname, '../public/lessons');
const sources = JSON.parse(readFileSync(resolve(lessonsDir, 'video-sources.json'), 'utf8')) as {
  videoUrl: string; title: string; publisher: string; thumbnailUrl: string; localThumbnail: string;
}[];

describe('the guides\' videos', () => {
  it('lists two videos on each of the six guides', () => {
    for (const phase of PHASES) {
      const videos = LESSONS[phase].videos ?? [];
      expect(videos.length, phase).toBe(2);
      for (const video of videos) {
        expect(video.title.trim().length, `${phase} ${video.id}`).toBeGreaterThan(0);
        expect(video.publisher.trim().length, `${phase} ${video.id}`).toBeGreaterThan(0);
        // A YouTube video id: eleven characters of this alphabet.
        expect(video.id, phase).toMatch(/^[A-Za-z0-9_-]{11}$/);
      }
    }
  });

  /* Each guide shows its videos under all four chapters, so the row says
   * which chapter each goes with: each video names its chapter, chosen with the research
   * that picked it, or none where it fits the whole guide. */
  it('says which chapter each video goes with', () => {
    const chapters = Object.fromEntries(PHASES.map((phase) => [phase, (LESSONS[phase].videos ?? []).map((video) => [video.id, video.chapter ?? null])]));
    expect(chapters).toEqual({
      requirements: [['FzRo35jRw7c', 2], ['1eSvoPUg2-g', null]],
      design: [['lsMQRaeKNDk', 1], ['xsg9BDiwiJE', 2]],
      implementation: [['_jKylhJtPmI', 2], ['DTBta08fXGU', 3]],
      testing: [['10jYq_d8fks', 1], ['w2VI8YAFMcw', 4]],
      deployment: [['Gjnup-PuquQ', 1], ['f3xb7kt_dH4', 3]],
      maintenance: [['9yeOJ0ZMUYw', 2], ['pznFqp8bIjs', 3]],
    });
    for (const phase of PHASES) {
      const numbered = (LESSONS[phase].videos ?? []).flatMap((video) => (video.chapter ? [video.chapter] : []));
      // In chapter order, and each a chapter the guide has.
      expect(numbered, phase).toEqual([...numbered].sort((a, b) => a - b));
      for (const chapter of numbered) expect(chapter >= 1 && chapter <= LESSONS[phase].chapters.length, phase).toBe(true);
    }
  });

  /* Guide words carry no pipe, middle dot or em dash. YouTube's own title
   * stays whole in video-sources.json; the guide shows its leading part,
   * since the channel is already the publisher. */
  it('shows no pipe, middle dot or em dash in any video title or publisher', () => {
    for (const phase of PHASES) {
      for (const video of LESSONS[phase].videos ?? []) {
        expect(video.title, `${phase} ${video.id}`).not.toMatch(/[|·—]/);
        expect(video.publisher, `${phase} ${video.id}`).not.toMatch(/[|·—]/);
      }
    }
    const shown = (id: string) => PHASES.flatMap((phase) => LESSONS[phase].videos ?? []).find((video) => video.id === id)!.title;
    expect(shown('1eSvoPUg2-g')).toBe('Creating an issue in Jira');
    expect(shown('w2VI8YAFMcw')).toBe('Mutation Testing with Stryker (with Adrianne Mallett)');
  });

  it('uses each video once across the guides', () => {
    const ids = PHASES.flatMap((phase) => (LESSONS[phase].videos ?? []).map((video) => video.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a local poster file and a source record for every video', () => {
    for (const phase of PHASES) {
      for (const video of LESSONS[phase].videos ?? []) {
        const poster = `video-${video.id}.jpg`;
        expect(existsSync(resolve(lessonsDir, poster)), `${phase}: ${poster}`).toBe(true);
        // A JPEG file starts with the bytes FF D8.
        const head = readFileSync(resolve(lessonsDir, poster)).subarray(0, 2);
        expect([head[0], head[1]], poster).toEqual([0xff, 0xd8]);
        const record = sources.find((entry) => entry.localThumbnail === poster);
        expect(record, `${phase}: no record for ${poster}`).toBeDefined();
        expect(record!.videoUrl).toBe(`https://www.youtube.com/watch?v=${video.id}`);
        // The record keeps YouTube's own title; the guide may show its leading
        // part (guide words carry no pipe: a title such as "X | Series" shows as "X").
        expect(record!.title.startsWith(video.title), `${poster}: ${record!.title}`).toBe(true);
      }
    }
  });
});
