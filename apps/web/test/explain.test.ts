import { describe, expect, it } from 'vitest';
import type { AssistantMessageView } from '@learnsdlc/shared';
import { explainQuestionFor } from '@learnsdlc/shared';
import { explainedTests } from '@/components/shell/PersonaPanel';

/**
 * Whether a test has already been explained is read off the
 * learner's own turns rather than out of a column, because the question the
 * product types for them is a fixed sentence and that sentence is the record.
 * These two cases are what makes that safe: the template has one author, and a
 * question somebody typed themselves does not count as one of the product's.
 */

const user = (content: string, id = 'u1'): AssistantMessageView => ({
  id,
  role: 'user',
  content,
  createdAt: '2026-09-06T10:00:00.000Z',
});
const assistant = (content: string, id = 'a1'): AssistantMessageView => ({
  id,
  role: 'assistant',
  content,
  createdAt: '2026-09-06T10:00:01.000Z',
});

describe('explainedTests', () => {
  it('finds the tests this thread has already been asked about', () => {
    const asked = explainedTests([
      user('Why does test_overdue_excludes_today fail?', 'u1'),
      assistant('It checks the boundary.', 'a1'),
      user('Why does isOverdue rejects today fail?', 'u2'),
      assistant('The same rule, in TypeScript.', 'a2'),
    ]);
    expect([...asked.keys()]).toEqual([
      'test_overdue_excludes_today',
      'isOverdue rejects today',
    ]);
    // The value is the turn to scroll to, so pressing the button again is a
    // way back to the answer rather than a second hint.
    expect(asked.get('test_overdue_excludes_today')).toBe('u1');
  });

  it('does not count a question the learner typed themselves', () => {
    const asked = explainedTests([
      // The product's sentence is the whole message, full stop. These three
      // are a person talking.
      user('Why does test_overdue_excludes_today fail? I have tried two things', 'u1'),
      user('So, why does test_overdue_excludes_today fail?', 'u2'),
      user('Why does test_overdue_excludes_today fail', 'u3'),
      // And an assistant turn quoting the question back is not the asking of it.
      assistant('Why does test_overdue_excludes_today fail?'),
    ]);
    expect(asked.size).toBe(0);
  });

  it('keeps the first turn that asked, so the button goes back to the answer', () => {
    const asked = explainedTests([
      user('Why does test_boundary fail?', 'u1'),
      assistant('Read the boundary again.', 'a1'),
      user('Why does test_boundary fail?', 'u2'),
    ]);
    expect(asked.size).toBe(1);
    expect(asked.get('test_boundary')).toBe('u1');
  });

  it('the question the browser draws matches the one the API records', () => {
    // The template lives in the shared package for this reason: two copies
    // would drift apart on the first edit, and the browser would stop
    // recognising the turns the server had written.
    expect(explainQuestionFor('test_overdue_excludes_today')).toBe(
      'Why does test_overdue_excludes_today fail?',
    );
    const asked = explainedTests([user(explainQuestionFor('test_x'))]);
    expect(asked.has('test_x')).toBe(true);
  });
});
