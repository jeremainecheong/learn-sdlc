// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceShortcutBlocked } from '@/lib/workspace-shortcuts';

afterEach(() => { document.body.replaceChildren(); });
describe('workspace actions respect the active conversation', () => {
  it('leaves workspace shortcuts available while a compact chat is visible', () => {
    document.body.innerHTML = '<button id="run">Run</button><dialog open class="chat-surface"><textarea></textarea></dialog>';
    expect(workspaceShortcutBlocked(document.querySelector('#run'))).toBe(false);
    expect(workspaceShortcutBlocked(document.querySelector('textarea'))).toBe(true);
  });
  it('blocks background actions for expanded conversations regardless of key target', () => {
    document.body.innerHTML = '<button id="run">Run</button><dialog open class="chat-surface" aria-modal="true"><button>Restore</button></dialog>';
    expect(workspaceShortcutBlocked(document.querySelector('#run'))).toBe(true);
    expect(workspaceShortcutBlocked(document.body)).toBe(true);
  });
  it('honors a nested help dialog and releases shortcuts after it closes', () => {
    document.body.innerHTML = '<button id="run">Run</button><dialog open class="chat-surface"><dialog open id="help"></dialog></dialog>';
    expect(workspaceShortcutBlocked(document.querySelector('#run'))).toBe(true);
    document.querySelector('#help')!.removeAttribute('open');
    expect(workspaceShortcutBlocked(document.querySelector('#run'))).toBe(false);
  });
  it('also protects ordinary open confirmation dialogs and non-element key targets', () => {
    document.body.innerHTML = '<dialog open><button>Cancel</button></dialog>';
    expect(workspaceShortcutBlocked(null)).toBe(true);
    document.querySelector('dialog')!.removeAttribute('open');
    expect(workspaceShortcutBlocked(null)).toBe(false);
  });
});
