// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonaPanel } from '@/components/shell/PersonaPanel';
const calls = vi.hoisted(() => ({ lessonHistory: vi.fn(), lessonChat: vi.fn(), chat: vi.fn(), loadRecords: vi.fn(), stuck: vi.fn(), proposals: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({ mentorApi: { lessonHistory: calls.lessonHistory, lessonChat: calls.lessonChat, stuck: calls.stuck }, agentApi: { list: calls.proposals } }));
vi.mock('@/lib/api', () => ({ api: { chat: calls.chat }, ApiError: class extends Error {}, describeError: (error: Error) => error.message }));
vi.mock('@/lib/records', () => ({ cachedRecords: () => ({}), loadRecords: calls.loadRecords }));
vi.mock('@/lib/useProject', () => ({ useProjectMaybe: () => ({ analytics: { tokensToday: 350000 } }) }));
let root: Root; let host: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); calls.lessonHistory.mockResolvedValue([]); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe('optional lesson mentors', () => {
 it('uses private lesson history and Guided teaching even when its project phase is locked', async () => {
  calls.lessonHistory.mockResolvedValue([{ id: 'lesson-reply', role: 'assistant', content: 'Explore the boundary in the lesson example.', createdAt: '2026-09-10T00:00:00Z' }]);
  await act(async () => root.render(<PersonaPanel lesson phaseKey="testing" phaseStateId="locked-testing-lesson" />));
  expect(calls.lessonHistory).toHaveBeenCalledWith('locked-testing-lesson');
  expect(calls.loadRecords).not.toHaveBeenCalled();
  expect(calls.stuck).not.toHaveBeenCalled();
  expect(calls.proposals).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Explore the boundary');
  expect(host.textContent).toContain('Guided lesson conversation');
  expect(Array.from(host.querySelectorAll('button')).some(button => button.textContent === 'Agentic')).toBe(false);
  expect(host.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')?.readOnly).toBe(false);
 });
 it('sends teaching questions to the lesson endpoint without invoking project chat or editing', async () => {
  calls.lessonChat.mockResolvedValue({ reply: { id: 'teaching-reply', role: 'assistant', content: 'Which boundary does your proposed check exercise?', createdAt: '2026-09-10T00:00:00Z' }, usage: { todayTokens: 350005 } });
  await act(async () => root.render(<PersonaPanel lesson phaseKey="design" phaseStateId="locked-design-lesson" />));
  const input = host.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
  act(() => { fireEvent.change(input, { target: { value: 'How do I separate a contract from its implementation?' } }); });
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!.click());
  expect(calls.lessonChat).toHaveBeenCalledWith('locked-design-lesson', 'How do I separate a contract from its implementation?');
  expect(calls.chat).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Which boundary does your proposed check exercise?');
  expect(host.querySelector('[data-testid="mentor-token-usage"]')).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="chat-details-toggle"]')!.click());
  expect(host.querySelector('[data-testid="mentor-token-usage"]')?.textContent).toBe('350,005 tokens used today');
  expect(host.querySelector('[data-testid="budget-meter"]')).toBeNull();
  expect(input.readOnly).toBe(false);
 });
 it('keeps a historical quota refusal readable while allowing a new question above the former limit', async () => {
  const oldReply = "You've reached today's AI budget (300,000 tokens).";
  calls.lessonHistory.mockResolvedValue([{ id: 'old-limit', role: 'assistant', content: oldReply, createdAt: '2026-09-10T00:00:00Z', meta: { provider: 'guardrail', budgetExceeded: true } }]);
  calls.lessonChat.mockResolvedValue({ reply: { id: 'new-guidance', role: 'assistant', content: 'What observation would distinguish the two cases?', createdAt: '2026-09-11T00:00:00Z' }, usage: { todayTokens: 350010 } });
  await act(async () => root.render(<PersonaPanel lesson phaseKey="requirements" phaseStateId="historical-limit-lesson" />));
  expect(host.textContent).toContain(oldReply);
  expect(host.textContent).toContain('Earlier token limit');
  expect(host.textContent).toContain('Daily token limits no longer apply.');
  const input = host.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
  expect(input.readOnly).toBe(false);
  act(() => { fireEvent.change(input, { target: { value: 'How can I distinguish a need from a suggested screen?' } }); });
  const send = host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!;
  expect(send.disabled).toBe(false);
  await act(async () => send.click());
  expect(calls.lessonChat).toHaveBeenCalledWith('historical-limit-lesson', 'How can I distinguish a need from a suggested screen?');
  expect(host.textContent).toContain('What observation would distinguish the two cases?');
  expect(host.textContent).toContain(oldReply);
 });

});
