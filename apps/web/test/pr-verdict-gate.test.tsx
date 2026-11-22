// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergeCard } from '@/components/pr/MergeCard';
let host:HTMLDivElement;let root:Root;
const merge=vi.fn();
const props={pr:'PR-6',merged:false,gateMet:true,score:100,gate:70,attempt:1,reason:'Fix the missing regression evidence.',reflection:null,next:null,nextHref:'/complete',busy:false,submitLabel:'Submit again',onMerge:merge,onSubmitAgain:vi.fn(),commitMessage:'',setCommitMessage:vi.fn()};
beforeEach(()=>{merge.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});
describe('Binary PR advancement',()=>{
 it('allows a passed phase to continue with the optional reflection blank',()=>{
  act(()=>root.render(<MergeCard {...props}/>));
  const advance=host.querySelector<HTMLButtonElement>('[data-testid=reflection-submit]')!;
  expect(advance.disabled).toBe(false);act(()=>advance.click());expect(merge).toHaveBeenCalledWith('');
  expect(host.textContent).toContain('Pass. Every required criterion');
  expect(host.textContent).not.toMatch(/score|gate 70|needs 70|Available at 70/i);
 });
 it('keeps advancement blocked when the verdict failed even with a legacy score of100',()=>{
  act(()=>root.render(<MergeCard {...props} gateMet={false}/>));
  expect(host.querySelector<HTMLButtonElement>('[data-testid=reflection-submit]')!.disabled).toBe(true);
  expect(host.textContent).toContain('Needs revision. Fix the missing regression evidence.');
  expect(merge).not.toHaveBeenCalled();
 });
});
