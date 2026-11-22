// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IssueDesk } from '@/components/workspace/panels/requirements/IssueDesk';
import { EMPTY_STORY } from '@/components/workspace/panels/requirements/story';
import { storyView } from '@/components/workspace/panels/requirements/useStory';
import { DEFAULT_STORY_FLOOR, type ProvidedStory } from '@learnsdlc/shared';
const SPEC={id:'US-4',hints:{},floor:DEFAULT_STORY_FLOOR,providedStories:[]};
const ADD_A_TASK:ProvidedStory={id:'US-1',title:'Add a task',persona:'team member',capability:'to add a titled task',benefit:'nothing is forgotten'};
let root: Root; let host: HTMLDivElement;
const save=vi.fn();
const button=(text:string)=>Array.from(host.querySelectorAll('button')).find(item=>item.textContent===text)!;
const change=(element:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement,value:string)=>act(()=>{fireEvent.change(element, { target: { value: value } });});
const renderDesk=(briefOpen:boolean,options:{active?:boolean;embedded?:boolean;providedStories?:ProvidedStory[];disabled?:boolean;onPendingDraftChange?:(pending:boolean)=>void}={})=>{
 const story={...EMPTY_STORY,title:'Overdue report',epics:[{id:'EP-1',title:'Reliable reporting',outcome:'Find missed work'}],parentEpicId:''};
 act(()=>root.render(<IssueDesk view={storyView(JSON.stringify(story),SPEC)} providedStories={[ADD_A_TASK]} projectTitle="TaskTrackr" statusLabel="In progress" statusTone="accent" storyState="now" assignedTo="Learner" canRecord setStory={save} phaseId="phase-fixture" briefPanel={{id:'requirements-brief',open:briefOpen}} {...options}/>));
};
beforeEach(()=>{
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(){this.setAttribute('open','');}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value(){this.removeAttribute('open');}});
 save.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);
 renderDesk(true);
});
afterEach(()=>{act(()=>root.unmount());host.remove();});
describe('Requirements issue dialogs',()=>{
 it('suspends an epic modal during an agentic lock and rejects its retained save handler',()=>{
  const pending=vi.fn();
  renderDesk(false,{embedded:true,onPendingDraftChange:pending});
  act(()=>host.querySelector<HTMLButtonElement>('[aria-label="Create epic"]')!.click());
  const title=host.querySelector<HTMLInputElement>('.jira-epic-form input')!;
  change(title,'An uncommitted epic');
  const dialog=host.querySelector('dialog')!;
  expect(pending).toHaveBeenLastCalledWith(true);
  renderDesk(false,{embedded:true,disabled:true,onPendingDraftChange:pending});
  expect(dialog.open).toBe(false);
  act(()=>fireEvent.submit(host.querySelector('form')!));
  expect(save).not.toHaveBeenCalled();
  expect(title.value).toBe('An uncommitted epic');
  renderDesk(false,{embedded:true,disabled:false,onPendingDraftChange:pending});
  expect(dialog.open).toBe(true);
  act(()=>button('Cancel').click());
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(save).not.toHaveBeenCalled();
 });
 it('suspends the modal when its workspace tab is hidden and restores the unsaved draft on return',()=>{
  renderDesk(false,{embedded:true,active:true});
  change(host.querySelector<HTMLInputElement>('[aria-label="Search backlog"]')!,'US-4');
  act(()=>button('Edit your story').click());
  const title=host.querySelector<HTMLTextAreaElement>('[data-testid="phase-requirements-title"]')!;
  change(title,'Keep this draft across history navigation');
  const dialog=host.querySelector('dialog')!;
  renderDesk(false,{embedded:true,active:false});
  expect(dialog.open).toBe(false);
  expect(host.querySelector('dialog')).toBe(dialog);
  expect(host.querySelector('[data-testid="phase-requirements-title"]')).toBe(title);
  expect(title.value).toBe('Keep this draft across history navigation');
  renderDesk(false,{embedded:true,active:true});
  expect(dialog.open).toBe(true);
  expect(title.value).toBe('Keep this draft across history navigation');
  expect(host.querySelector<HTMLInputElement>('[aria-label="Search backlog"]')!.value).toBe('US-4');
  expect(save).not.toHaveBeenCalled();
 });
 it('opens the selected supplied story’s real acceptance content without an editor or unrelated stories',()=>{
  renderDesk(false,{embedded:true,providedStories:[
   {...ADD_A_TASK,criteria:[{id:'AC-1',given:'an existing list',when:'I add a titled task',then:'it is saved',tag:'happy'}]},
   {id:'US-2',title:'Complete a task',persona:'team member',capability:'to mark a task done',benefit:'A different requirement'},
  ]});
  act(()=>Array.from(host.querySelectorAll<HTMLButtonElement>('.jira-issue-row')).find(item=>item.textContent?.includes('US-1'))!.click());
  const dialog=host.querySelector('dialog')!;
  expect(dialog.textContent).toContain('As a team member, I want to add a titled task, so that nothing is forgotten.');
  expect(dialog.textContent).toContain('Given an existing list, when I add a titled task, then it is saved.');
  expect(dialog.textContent).not.toContain('A different requirement');
  expect(dialog.querySelector('input,textarea,[contenteditable]')).toBeNull();
  expect(save).not.toHaveBeenCalled();
 });
 it('hides only the brief while preserving backlog filtering, the open draft, and its selection',()=>{
  const filter=host.querySelector<HTMLInputElement>('[aria-label="Search backlog"]')!;
  change(filter,'US-4');
  act(()=>button('Edit your story').click());
  const title=host.querySelector<HTMLTextAreaElement>('[data-testid="phase-requirements-title"]')!;
  change(title,'Draft kept while panels change');
  title.setSelectionRange(6,10);
  const brief=host.querySelector<HTMLElement>('#requirements-brief')!;
  renderDesk(false);
  expect(brief.hidden).toBe(true);
  expect(host.querySelector('#requirements-brief')).toBe(brief);
  expect(host.querySelector('[data-testid="phase-requirements-title"]')).toBe(title);
  expect(title.value).toBe('Draft kept while panels change');
  expect([title.selectionStart,title.selectionEnd]).toEqual([6,10]);
  expect(filter.value).toBe('US-4');
  renderDesk(true);
  expect(brief.hidden).toBe(false);
  expect(host.querySelector('dialog[open]')).not.toBeNull();
  expect(title.value).toBe('Draft kept while panels change');
  expect(save).not.toHaveBeenCalled();
 });
 it('keeps cancelled story edits out of the saved record',()=>{
  act(()=>button('Edit your story').click());
  change(host.querySelector<HTMLTextAreaElement>('[data-testid="phase-requirements-title"]')!,'Uncommitted title');
  expect(save).not.toHaveBeenCalled();act(()=>button('Cancel').click());
  expect(host.querySelector('dialog')).toBeNull();expect(save).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Overdue report');expect(host.textContent).not.toContain('Uncommitted title');
 });
 it('wraps a long title in a labelled textarea while preserving one logical title and explicit save intent',()=>{
  act(()=>button('Edit your story').click());
  const title=host.querySelector<HTMLTextAreaElement>('[data-testid="phase-requirements-title"]')!;
  expect(title.tagName).toBe('TEXTAREA');
  expect(host.querySelector(`label[for="${title.id}"]`)?.textContent).toBe('Story title');
  change(title,'Read overdue tasks across several project lists\nwithout including completed, undated, or due-today work');
  expect(title.value).toBe('Read overdue tasks across several project lists without including completed, undated, or due-today work');
  expect(save).not.toHaveBeenCalled();
  title.setSelectionRange(5,18);
  renderDesk(false);
  expect(host.querySelector('[data-testid="phase-requirements-title"]')).toBe(title);
  expect([title.selectionStart,title.selectionEnd]).toEqual([5,18]);
  act(()=>button('Cancel').click());
  expect(save).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Overdue report');
 });
 it('saves the parent relationship and edited criterion together only when Save story is pressed',()=>{
  act(()=>button('Edit your story').click());
  change(host.querySelector<HTMLSelectElement>('[aria-label="Parent epic"]')!,'EP-1');
  act(()=>host.querySelector<HTMLButtonElement>('[data-testid="phase-requirements-criterion-add"]')!.click());
  change(host.querySelector<HTMLTextAreaElement>('[data-testid="phase-requirements-criterion-1-given"]')!,'an open task due yesterday');
  change(host.querySelector<HTMLTextAreaElement>('[data-testid="phase-requirements-criterion-1-when"]')!,'the report opens');
  change(host.querySelector<HTMLTextAreaElement>('[data-testid="phase-requirements-criterion-1-then"]')!,'the task appears');
  expect(save).not.toHaveBeenCalled();act(()=>button('Save story').click());
  expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0][0]).toMatchObject({id:'US-4',parentEpicId:'EP-1',criteria:[{id:'AC-1',given:'an open task due yesterday',when:'the report opens',then:'the task appears'}]});
 });
 it('refuses to save an untitled story, says why in the dialog, and saves once it has one (F-r)',()=>{
  act(()=>button('Edit your story').click());
  const title=host.querySelector<HTMLTextAreaElement|HTMLInputElement>('[data-testid="phase-requirements-title"]')!;
  change(title as HTMLTextAreaElement,'   ');
  act(()=>button('Save story').click());
  expect(save).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="story-title-needed"]')?.textContent).toBe('Give the story a title before you save it. The review reads the title first.');
  expect(host.querySelector('[data-testid="story-title-needed"]')?.getAttribute('role')).toBe('alert');
  change(title as HTMLTextAreaElement,'Overdue report');
  expect(host.querySelector('[data-testid="story-title-needed"]')).toBeNull();
  act(()=>button('Save story').click());
  expect(save).toHaveBeenCalledTimes(1);
 });
 it('creates a distinct epic without replacing the story or its earlier epic',()=>{
  act(()=>host.querySelector<HTMLButtonElement>('[aria-label="Create epic"]')!.click());
  const fields=host.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('.jira-epic-form input,.jira-epic-form textarea');
  change(fields[0],'Clear boundaries');change(fields[1],'Reduce ambiguous report behavior');
  act(()=>fireEvent.submit(host.querySelector('form')!));
  expect(save.mock.calls[0][0].epics).toEqual([{id:'EP-1',title:'Reliable reporting',outcome:'Find missed work'},{id:'EP-2',title:'Clear boundaries',outcome:'Reduce ambiguous report behavior'}]);
  expect(save.mock.calls[0][0].title).toBe('Overdue report');
 });
 it('keeps provided stories read-only and filters the actual backlog',()=>{
  act(()=>Array.from(host.querySelectorAll<HTMLButtonElement>('.jira-issue-row')).find(item=>item.textContent?.includes('US-1'))!.click());
  expect(host.querySelector('dialog')?.textContent).toContain('Provided project contract');
  expect(host.querySelector('dialog input,dialog textarea')).toBeNull();
  act(()=>host.querySelector<HTMLButtonElement>('[aria-label="Close issue dialog"]')!.click());
  change(host.querySelector<HTMLInputElement>('[aria-label="Search backlog"]')!,'US-4');
  expect(host.querySelectorAll('.jira-issue-row')).toHaveLength(1);expect(save).not.toHaveBeenCalled();
 });
 it('explains an empty filtered result and clears query, issue type and epic restrictions without changing the story',()=>{
  act(()=>Array.from(host.querySelectorAll<HTMLButtonElement>('.jira-epic-list button')).find(item=>item.textContent?.includes('Reliable reporting'))!.click());
  change(host.querySelector<HTMLSelectElement>('[aria-label="Issue type filter"]')!,'story');
  change(host.querySelector<HTMLInputElement>('[aria-label="Search backlog"]')!,'unmatched phrase');
  expect(host.querySelectorAll('.jira-issue-row')).toHaveLength(0);
  expect(host.querySelector('[role="status"]')?.textContent).toContain('No issues match these filters.');
  act(()=>button('Clear filters').click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="Search backlog"]')!.value).toBe('');
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Issue type filter"]')!.value).toBe('all');
  expect(host.querySelectorAll('.jira-issue-row')).toHaveLength(3);
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(save).not.toHaveBeenCalled();
 });
 it('distinguishes a collection with no epics from a query hiding existing work',()=>{
  const story={...EMPTY_STORY,title:'Overdue report',epics:[]};
  act(()=>root.render(<IssueDesk view={storyView(JSON.stringify(story),SPEC)} projectTitle="TaskTrackr" statusLabel="In progress" statusTone="accent" storyState="now" assignedTo="Learner" canRecord setStory={save}/>));
  change(host.querySelector<HTMLSelectElement>('[aria-label="Issue type filter"]')!,'epic');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('No epics yet.');
  expect(button('Clear filters')).toBeUndefined();
  expect(save).not.toHaveBeenCalled();
 });

});
