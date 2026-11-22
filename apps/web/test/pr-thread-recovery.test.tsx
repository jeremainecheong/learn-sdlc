// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Thread } from '@/components/pr/Thread';
import type { PrThread } from '@/components/pr/threads';
const thread: PrThread = { key:'kept-review',kind:'test',path:'api/read.py',line:7,state:'open',resolvedIn:null,source:'case_rows',message:'The row is repeated.',ask:'What produces each row?',who:'Sage',initials:'S',claim:null,severity:'error' };
function deferred(){let resolve!:(answer:string)=>void,reject!:(error:Error)=>void;const promise=new Promise<string>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
let host:HTMLDivElement,root:Root;
const input=()=>host.querySelector('input')!;
const button=()=>host.querySelector<HTMLButtonElement>('[data-testid=pr-reply-send-1]')!;
const type=(value:string)=>act(()=>{fireEvent.change(input(), { target: { value: value } });});
const click=()=>act(()=>{button().focus();button().click();});
const render=(onReply:(thread:PrThread,text:string)=>Promise<string>,hidden=false,closedByMerge=false)=>act(()=>root.render(<><button data-testid="elsewhere">Other tab</button><div hidden={hidden}><Thread thread={thread} phaseKey="maintenance" index={1} onReply={onReply} closedByMerge={closedByMerge}/></div></>));
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});

describe('actual PR Thread failure and retry',()=>{
 it('keeps the exact failed draft visible and focused, and retries it without claiming an answer',async()=>{
  const pending=deferred(),reply=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce('Reviewed reply from the controlled test transport.');render(reply);type('  Which join produced this row?  ');const original=input();click();
  expect(input()).toBe(original);expect(input().value).toBe('');expect(host.querySelector('[data-testid=pr-reply-question-1]')?.textContent).toContain('Which join produced this row?');expect(host.querySelector('[role=status]')?.textContent).toBe('Sending…');expect(input().disabled).toBe(false);expect(button().disabled).toBe(true);expect(document.activeElement).toBe(input());
  await act(async()=>pending.reject(new Error('The service is unavailable')));
  expect(input().value).toBe('  Which join produced this row?  ');expect(button().disabled).toBe(false);expect(host.querySelector('[role=alert]')?.textContent).toContain('Your question is kept');expect(input().getAttribute('aria-describedby')).toBe(host.querySelector('[role=alert]')?.id);
  click();await act(async()=>{});expect(reply).toHaveBeenNthCalledWith(2,thread,'Which join produced this row?');expect(input().value).toBe('');expect(host.querySelector('[role=alert]')).toBeNull();expect(host.textContent).toContain('Reviewed reply from the controlled test transport.');
 });
 it.each(['resolve','reject'] as const)('never overwrites a newer draft or steals focus after another tab is selected when the request %ss',async outcome=>{
  const pending=deferred(),reply=vi.fn(()=>pending.promise);render(reply);type('The submitted question.');click();type('My newer unsent question.');
  act(()=>fireEvent.keyDown(input(),{key:'Enter'}));expect(reply).toHaveBeenCalledTimes(1);
  const other=host.querySelector<HTMLButtonElement>('[data-testid=elsewhere]')!;act(()=>other.focus());render(reply,true);
  await act(async()=>outcome==='resolve'?pending.resolve('Controlled response.'):pending.reject(new Error('Connection interrupted')));
  expect(document.activeElement).toBe(other);render(reply);expect(input().value).toBe('My newer unsent question.');expect(button().disabled).toBe(false);
  if(outcome==='reject')expect(host.querySelector('[role=alert]')?.textContent).toContain('Connection interrupted');else expect(host.textContent).toContain('Controlled response.');
 });
 it('keeps failed question history but removes retry controls when the thread closes',async()=>{const pending=deferred(),reply=vi.fn(()=>pending.promise);render(reply);type('Original question.');click();render(reply,false,true);await act(async()=>pending.reject(new Error('Unavailable')));expect(host.querySelector('[data-testid=pr-reply-question-1]')?.textContent).toContain('Original question.');expect(host.querySelector('[data-testid=pr-reply-retry-1]')).toBeNull();expect(host.querySelector('input')).toBeNull();expect(reply).toHaveBeenCalledTimes(1);});
 it('retries the retained failed question without replacing a newer composer draft',async()=>{
  const pending=deferred(),reply=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce('Controlled retry response.');render(reply);type('Original question.');click();type('Newer unsent question.');
  await act(async()=>pending.reject(new Error('Unavailable')));expect(input().value).toBe('Newer unsent question.');expect(host.querySelector('[data-testid=pr-reply-question-1]')?.textContent).toContain('Original question.');
  act(()=>host.querySelector<HTMLButtonElement>('[data-testid=pr-reply-retry-1]')!.click());await act(async()=>{});
  expect(reply).toHaveBeenNthCalledWith(2,thread,'Original question.');expect(input().value).toBe('Newer unsent question.');expect(host.querySelector('[role=alert]')).toBeNull();expect(host.textContent).toContain('Controlled retry response.');
 });
});
