// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({chat:vi.fn(),submit:vi.fn(),selected:vi.fn(),fileRevisionId:'original-submission',phase:{id:'phase-pr-continuity',key:'maintenance',title:'Maintenance',order:6,status:'in_progress',projectSlug:'tasktrackr',rubric:{},attempts:1,reflection:null}}));
vi.mock('next/navigation',()=>({useParams:()=>({phaseId:mocks.phase.id}),useRouter:()=>({push:vi.fn()})}));
vi.mock('@/lib/api',()=>({api:{chat:mocks.chat}}));
vi.mock('@/lib/rail',()=>({railOf:()=>({})}));
vi.mock('@/lib/commit',()=>({useCommitDraft:()=>['',vi.fn()]}));
vi.mock('@/lib/useProject',()=>({useProject:()=>({details:{[mocks.phase.id]:mocks.phase},enrollment:{projectTitle:'TaskTrackr',phases:[],releases:[],currentPhaseOrder:6},analytics:null,currentPhase:null,reload:vi.fn()}),invalidateProject:vi.fn()}));
vi.mock('@/components/workspace/QueueLine',()=>({QueueLine:()=>null}));
vi.mock('@/components/workspace/PhaseDocumentFrame',()=>({PhaseDocumentFrame:({children,contentRef}:{children:React.ReactNode;contentRef:React.Ref<HTMLDivElement>})=><div ref={contentRef} data-testid="scroll-host" style={{overflowY:'auto'}}>{children}</div>}));
vi.mock('@/components/shell',()=>({DocPage:()=>null,briefHref:()=>'/brief',phaseDoorHref:()=>'/workspace/next',solutionHref:()=>'/solution',usePersona:()=>null,PERSONA_NAME:{maintenance:'Sage'}}));
vi.mock('@/components/shell/PersonaPanel',()=>({MentorSession:()=>null}));
vi.mock('@/components/pr',async()=>{
 const {Conversation}=await import('@/components/pr/Conversation');
 const {DiffView}=await import('@/components/pr/DiffView');
 const t={key:'original-thread',state:'open',kind:'test',path:'api/read.py',line:1,who:'Sage',initials:'S',ask:'What prevents duplicate task rows?',message:'The grouped result is duplicated.',source:'read contract',claim:null};
 const head={id:'original-submission',attempt:1,score:null,report:{passed:false,aiReview:{assessmentError:false}}};
 return {Conversation,DiffView,ChecksCard:()=>null,SubmissionsCard:()=>null,MergeCard:()=>null,gateReason:()=>'',prHeadline:()=> 'Inspect the original review',
  ChecksTab:()=> <p>Actual checks pane</p>,
  HistoryCard:({onOpenFiles}:{onOpenFiles:(id:string)=>void})=><button onClick={()=>onOpenFiles(head.id)}>Read selected files</button>,
  usePullRequest:()=>({detail:mocks.phase,head,threads:[t],diffs:[{path:t.path,adds:1,dels:0,hunks:[{skipped:0,lines:[{kind:'+',oldNo:null,newNo:1,text:'return tasks'}]}]}],revisions:[head],gate:0,fileRevision:{...head,id:mocks.fileRevisionId},fileBase:null,threadsFor:()=>[t],selectRevision:mocks.selected,submit:mocks.submit,filesKept:()=>true})};
});
const {default:PullRequestPage}=await import('@/app/(app)/workspace/[phaseId]/pr/page');
let host:HTMLDivElement,root:Root;
const tab=(name:string)=>host.querySelector<HTMLButtonElement>(`[data-testid=pr-tab-${name}]`)!;
const change=(input:HTMLInputElement,value:string)=>act(()=>{fireEvent.change(input, { target: { value: value } });});
const click=(button:HTMLButtonElement)=>act(()=>{button.focus();button.click();});
beforeEach(async()=>{vi.clearAllMocks();mocks.fileRevisionId='original-submission';host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(<PullRequestPage/>));});
afterEach(()=>{act(()=>root.unmount());host.remove();expect(mocks.submit).not.toHaveBeenCalled();});

describe('PR tab navigation preserves the original working state',()=>{
 it('keeps the actual diff reply, selection and horizontal reading position after switching to Conversation and back',()=>{
  expect(host.querySelector('[data-testid=pr-conversation]')).toBeNull();
  const fileInput=host.querySelector<HTMLInputElement>('[data-testid=pr-reply-1]')!;
  const diff=host.querySelector<HTMLElement>('[data-diff-scroll]')!;
  change(fileInput,'I am checking which join repeats this task.');fileInput.setSelectionRange(5,16);diff.scrollLeft=137;
  click(tab('conversation'));
  const conversation=host.querySelector<HTMLElement>('[data-testid=pr-conversation]')!;
  const otherInput=conversation.querySelector<HTMLInputElement>('input')!;
  change(otherInput,'A separate unsent question about the original review.');
  expect(fileInput.isConnected).toBe(true);expect(fileInput.closest('[hidden]')).not.toBeNull();
  click(tab('files'));
  expect(host.querySelector('[data-diff-scroll]')).toBe(diff);expect(diff.scrollLeft).toBe(137);
  expect(fileInput.value).toBe('I am checking which join repeats this task.');expect([fileInput.selectionStart,fileInput.selectionEnd]).toEqual([5,16]);
  expect(conversation.isConnected).toBe(true);expect(conversation.closest('[hidden]')).not.toBeNull();
  click(tab('conversation'));expect(conversation.querySelector('input')).toBe(otherInput);expect(otherInput.value).toContain('A separate unsent question');expect(mocks.chat).not.toHaveBeenCalled();
 });
 it('restores each tab scroll position before display and sends focus out of a hidden History action',()=>{
  const scroll=host.querySelector<HTMLElement>('[data-testid=scroll-host]')!;scroll.scrollTop=620;
  click(tab('checks'));expect(scroll.scrollTop).toBe(0);scroll.scrollTop=93;
  click(tab('files'));expect(scroll.scrollTop).toBe(620);
  click(tab('checks'));expect(scroll.scrollTop).toBe(93);
  click(tab('history'));const open=[...host.querySelectorAll('button')].find(b=>b.textContent==='Read selected files')!;
  click(open);expect(mocks.selected).toHaveBeenCalledWith('original-submission');expect(document.activeElement).toBe(tab('files'));expect(scroll.scrollTop).toBe(620);expect(mocks.chat).not.toHaveBeenCalled();
 });
 it('does not attach a source-local question or answer to another immutable revision of the same file',async()=>{
  mocks.chat.mockResolvedValue({reply:{content:'Controlled answer belonging to revision A.'}});
  const original=host.querySelector<HTMLInputElement>('[data-testid=pr-reply-1]')!;change(original,'Question belonging to revision A.');
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid=pr-reply-send-1]')!.click());
  expect(mocks.chat).toHaveBeenCalledTimes(1);expect(host.textContent).toContain('Controlled answer belonging to revision A.');change(original,'Unsent draft belonging to revision A.');
  mocks.fileRevisionId='historical-submission-B';await act(async()=>root.render(<PullRequestPage/>));
  expect(host.querySelector('[data-testid=pr-files-revision]')?.getAttribute('data-submission-id')).toBe('historical-submission-B');expect(original.isConnected).toBe(false);expect(host.querySelector('[data-testid=pr-reply-question-1]')).toBeNull();expect(host.textContent).not.toContain('Controlled answer belonging to revision A.');expect(host.querySelector('[data-testid=pr-reply-1]')).toBeNull();
  mocks.fileRevisionId='original-submission';await act(async()=>root.render(<PullRequestPage/>));expect(host.querySelector<HTMLInputElement>('[data-testid=pr-reply-1]')!.value).toBe('');expect(host.textContent).not.toContain('Controlled answer belonging to revision A.');
 });
});
