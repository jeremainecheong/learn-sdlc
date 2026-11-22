import { AUTHORED_GUIDED_REVIEW_PROMPT, GUIDED_REVIEW_EXEMPLARS, GUIDED_REVIEW_KEYS, GUIDED_REVIEW_PROMPT, GUIDED_REVIEW_SAFE_EXEMPLARS } from './guided-review';
import { AUTHORED_GUIDED_DRAFT_SELF_CHECK, GUIDED_DRAFT_SELF_CHECK } from './guided-draft';

/**
 * The Guided draft checks itself
 * the way its reviewer will, before the reviewer ever sees it. It is told the
 * reviewer's three checks, its decision procedure and the server's
 * remaining-reasoning rule, and shown the two replies the reviewer accepts.
 * The two it withholds are described in words, never quoted: a verbatim
 * over-helping answer in the generator's own system message is something it
 * could imitate or repeat to a learner.
 */
describe('the Guided draft self-check', () => {
  it('names every reviewer check and carries the reviewer\'s own SAFE exemplars, verbatim', () => {
    for (const key of GUIDED_REVIEW_KEYS) expect(GUIDED_DRAFT_SELF_CHECK).toContain(key);
    expect(GUIDED_REVIEW_SAFE_EXEMPLARS).toHaveLength(2);
    for (const safe of GUIDED_REVIEW_SAFE_EXEMPLARS) {
      expect(safe.startsWith('SAFE: "')).toBe(true);
      expect(GUIDED_REVIEW_PROMPT).toContain(safe);
      expect(GUIDED_DRAFT_SELF_CHECK).toContain(safe);
    }
  });

  it('describes the withheld replies in words and never quotes an UNSAFE exemplar', () => {
    expect(GUIDED_DRAFT_SELF_CHECK).not.toContain('UNSAFE');
    for (const line of GUIDED_REVIEW_EXEMPLARS.split('\n').filter((row) => row.startsWith('UNSAFE: '))) {
      const quoted = line.slice('UNSAFE: '.length, line.indexOf('" ', 8) + 1);
      expect(quoted.length).toBeGreaterThan(40);
      expect(GUIDED_DRAFT_SELF_CHECK).not.toContain(quoted);
    }
    for (const fragment of ['Return false when age is under 18', 'order by priority then ID', 'eligibility body']) {
      expect(GUIDED_DRAFT_SELF_CHECK).not.toContain(fragment);
    }
  });

  it('states the decision procedure and the server-derived remaining-reasoning rule', () => {
    expect(GUIDED_DRAFT_SELF_CHECK).toContain('name to yourself the one decision you are leaving to the learner');
    expect(GUIDED_DRAFT_SELF_CHECK).toContain('A question whose answer is already contained in what you just wrote is not remaining reasoning');
  });

  it('opens on its own line so it appends cleanly after the hard rules', () => {
    expect(GUIDED_DRAFT_SELF_CHECK.startsWith('\n')).toBe(true);
    expect(GUIDED_DRAFT_SELF_CHECK.endsWith('\n')).toBe(false);
  });

  it('gives a teacher\'s phase the same self-check, differing only where the authored reviewer does', () => {
    // The authored reviewer rewrites one span of its SAFE exemplar; the
    // authored self-check quotes that exemplar, so it rewrites the same span.
    const from = 'Trace the supplied due-today example';
    const to = 'Trace the supplied boundary example';
    expect(AUTHORED_GUIDED_REVIEW_PROMPT).toBe(GUIDED_REVIEW_PROMPT.replace(from, to));
    expect(AUTHORED_GUIDED_DRAFT_SELF_CHECK).toBe(GUIDED_DRAFT_SELF_CHECK.replace(from, to));
    expect(AUTHORED_GUIDED_DRAFT_SELF_CHECK).not.toContain('due-today');
    expect(AUTHORED_GUIDED_DRAFT_SELF_CHECK).not.toContain('TaskTrackr');
  });
});
