// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewSessionView } from '@learnsdlc/shared';
import { PreviewPanel } from '@/components/workspace/preview/PreviewPanel';
import {
  BUSY_TITLE,
  OWN_STARTING_BODY,
  OWN_STARTING_TITLE,
  OWN_STOPPING_BODY,
  OWN_STOPPING_MESSAGE,
  OWN_STOPPING_TITLE,
  REFUSED_TITLE,
  busyCopy,
  type PreviewRefusalFields,
} from '@/components/workspace/preview/copy';

/*
 * A Rebuild preview refused because the learner's own earlier app is still
 * stopping must not read "Every seat is taken" and "busy with the rest of the
 * class" with one learner on the host. The API answers that case in its own
 * sentence and an additive `reason`, and the panel titles it by the field,
 * reading the sentence only from an API without the field; a second tab's
 * start still launching says so; the class-full case keeps
 * its words, and every case keeps Try again.
 */

const CLASS_BUSY =
  'The code runner is busy with the rest of the class, so this did not run. Your work is saved. Try again in a moment.';

// The API's own-preview sentences (apps/api/src/preview/preview.service.ts).
const API_OWN_STARTING = 'Your preview is already starting. Give it a moment.';

const refused = (message: string, reason?: string): PreviewSessionView & PreviewRefusalFields => ({
  id: '', phaseStateId: 'p1', status: 'busy', url: null, bundleOk: true, message, stopReason: null,
  startedAt: '2026-11-09T10:00:00.000Z', readyAt: null, expiresAt: '2026-11-09T10:00:00.000Z',
  idleExpiresAt: '2026-11-09T10:00:00.000Z', bytesServed: 0, console: [], cursor: 0,
  ...(reason ? { reason: reason as PreviewRefusalFields['reason'] } : {}),
});

describe('busyCopy', () => {
  it('pins the API’s own-preview sentence word for word, for an API before the field', () => {
    expect(OWN_STOPPING_MESSAGE).toBe(
      'Your earlier preview is still stopping. Your work is saved. Try again in a moment.',
    );
  });

  it('titles the learner’s own stopping preview by the API’s reason, never as the class', () => {
    expect(busyCopy(refused(OWN_STOPPING_MESSAGE, 'own-preview-stopping'))).toEqual({
      title: OWN_STOPPING_TITLE, body: OWN_STOPPING_BODY,
    });
    expect(OWN_STOPPING_TITLE).toBe('Your earlier preview is still stopping');
    expect(OWN_STOPPING_BODY).toBe('Your work is saved. Try again in a moment.');
    expect(OWN_STOPPING_BODY).not.toMatch(/class|seat/i);
  });

  it('reads the reason, not the sentence: a reworded sentence keeps its title', () => {
    expect(busyCopy(refused('Your last app is still shutting down.', 'own-preview-stopping')).title)
      .toBe(OWN_STOPPING_TITLE);
    // And the field outranks a sentence that happens to read like the class.
    expect(busyCopy(refused(CLASS_BUSY, 'own-preview-starting')).title).toBe(OWN_STARTING_TITLE);
  });

  it('says a second tab’s start is still launching, never the class', () => {
    expect(busyCopy(refused(API_OWN_STARTING, 'own-preview-starting'))).toEqual({
      title: OWN_STARTING_TITLE, body: OWN_STARTING_BODY,
    });
    expect(OWN_STARTING_TITLE).toBe('Your preview is already starting');
    expect(OWN_STARTING_BODY).toBe('Give it a moment.');
    expect(`${OWN_STARTING_TITLE} ${OWN_STARTING_BODY}`).not.toMatch(/class|seat/i);
  });

  it('a new client on an API before the field: the own-stopping sentence still titles itself', () => {
    expect(busyCopy(refused(OWN_STOPPING_MESSAGE))).toEqual({ title: OWN_STOPPING_TITLE, body: OWN_STOPPING_BODY });
    expect(busyCopy({ message: ` ${OWN_STOPPING_MESSAGE} ` }).title).toBe(OWN_STOPPING_TITLE);
  });

  it('keeps the class-full words for a refusal with no reason, from either API', () => {
    expect(busyCopy(refused(CLASS_BUSY))).toEqual({ title: BUSY_TITLE, body: CLASS_BUSY });
    expect(BUSY_TITLE).toBe('Every seat is taken');
    expect(busyCopy(null)).toEqual({ title: BUSY_TITLE, body: '' });
  });

  it('never says every seat is taken for a reason it does not know (a newer API)', () => {
    expect(busyCopy(refused('Something else is in the way. Your work is saved.', 'own-preview-moving'))).toEqual({
      title: REFUSED_TITLE, body: 'Something else is in the way. Your work is saved.',
    });
    expect(REFUSED_TITLE).toBe('Your app is not running');
  });
});

describe('the panel, refused', () => {
  let root: Root;
  let host: HTMLDivElement;
  const onStart = vi.fn();
  beforeEach(() => {
    onStart.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const draw = (message: string, reason?: string) =>
    act(() =>
      root.render(
        <PreviewPanel
          status="busy"
          session={refused(message, reason)}
          apiUrl="http://localhost:4000"
          url={null}
          nonce={0}
          errors={0}
          starting={false}
          error=""
          unsupported={null}
          onStart={onStart}
          onStop={() => {}}
          onRefresh={() => {}}
          onOpenConsole={() => {}}
        />,
      ),
    );
  const busy = () => host.querySelector('[data-testid="preview-busy"]');

  it('says the earlier preview is still stopping, with Try again', () => {
    draw(OWN_STOPPING_MESSAGE, 'own-preview-stopping');
    const text = busy()?.textContent ?? '';
    expect(text).toContain(OWN_STOPPING_TITLE);
    expect(text).toContain(OWN_STOPPING_BODY);
    expect(text).not.toContain('Every seat is taken');
    expect(text).not.toContain('rest of the class');
    const again = host.querySelector('[data-testid="preview-run"]') as HTMLButtonElement;
    expect(again.textContent).toContain('Try again');
    act(() => again.click());
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('says the same from an API before the field, by its sentence', () => {
    draw(OWN_STOPPING_MESSAGE);
    const text = busy()?.textContent ?? '';
    expect(text).toContain(OWN_STOPPING_TITLE);
    expect(text).not.toContain('Every seat is taken');
  });

  it('says a second tab’s preview is already starting, with Try again', () => {
    draw(API_OWN_STARTING, 'own-preview-starting');
    const text = busy()?.textContent ?? '';
    expect(text).toContain('Your preview is already starting');
    expect(text).toContain('Give it a moment.');
    expect(text).not.toContain('Every seat is taken');
    expect(text).not.toContain('rest of the class');
    const again = host.querySelector('[data-testid="preview-run"]') as HTMLButtonElement;
    expect(again.textContent).toContain('Try again');
    act(() => again.click());
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('keeps "Every seat is taken" and the API’s sentence when the class is full', () => {
    draw(CLASS_BUSY);
    const text = busy()?.textContent ?? '';
    expect(text).toContain('Every seat is taken');
    expect(text).toContain(CLASS_BUSY);
    expect(host.querySelector('[data-testid="preview-run"]')?.textContent).toContain('Try again');
  });
});
