// @vitest-environment jsdom
import {act,useEffect} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({replace:vi.fn(),phaseId:'owned-phase',path:'/workspace/owned-phase',search:'',project:{currentPhase:null as null|{id:string;key:string;status:string},details:{} as Record<string,unknown>,enrollment:{phases:[] as unknown[]},loading:false,error:'',reload:vi.fn()},requirementsMount:vi.fn(),childMount:vi.fn()}));
// `useSearchParams` because the layout reads `?task=`: the bare workspace
// path is both the backlog's room and the room a second written task is worked
// in, and the query is what tells them apart.
vi.mock('next/navigation',()=>({useParams:()=>({phaseId:state.phaseId}),usePathname:()=>state.path,useSearchParams:()=>new URLSearchParams(state.search),useRouter:()=>({replace:state.replace})}));
vi.mock('@/lib/useProject',()=>({useProject:()=>state.project}));
vi.mock('@/components/shell',async()=>{const routes=await import('@/components/shell/routes');return{...routes,WorkPage:({children,heading,testId}:{children:React.ReactNode;heading:string;testId:string})=><main data-testid={testId}><h1>{heading}</h1>{children}</main>};});
vi.mock('@/components/workspace/requirements/RequirementsWorkspace',()=>({RequirementsWorkspace:()=>{useEffect(()=>{state.requirementsMount();},[]);return <div data-testid="requirements-persistent"/>;}}));
const {default:Layout}=await import('@/app/(app)/workspace/[phaseId]/layout');
let root:Root,host:HTMLDivElement;
function Child(){useEffect(()=>{state.childMount();},[]);return <div data-testid="child-tool"/>;}
const render=()=>act(()=>root.render(<Layout><Child/></Layout>));
function phase(key:string,status='in_progress'){state.project.enrollment.phases=[{id:state.phaseId,key,title:key[0].toUpperCase()+key.slice(1),status,order:3,attempts:1}];}
beforeEach(()=>{vi.clearAllMocks();state.path='/workspace/owned-phase';state.search='';state.project.currentPhase=null;state.project.details={};state.project.enrollment.phases=[];state.project.loading=false;host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});

describe('phase route boundaries run before mounting a tool',()=>{
 it.each([['interview','requirements'],['issue','requirements'],['design','design'],['matrix','testing'],['drill','deployment'],['change','maintenance']])('allows /%s only for its owning %s phase',(suffix,key)=>{
  phase(key==='requirements'?'testing':'requirements');state.path+='/'+suffix;render();expect(host.querySelector('[data-testid=phase-view-mismatch]')).not.toBeNull();expect(state.childMount).not.toHaveBeenCalled();expect(state.requirementsMount).not.toHaveBeenCalled();expect(host.querySelector('a')?.getAttribute('href')).toMatch(/^\/workspace\/owned-phase(?:\/interview)?$/);
  phase(key);render();expect(host.querySelector('[data-testid=phase-view-mismatch]')).toBeNull();expect(key==='requirements'?state.requirementsMount:state.childMount).toHaveBeenCalledTimes(1);
 });
 it.each(['','/interview','/issue','/design','/matrix','/drill','/change','/pr','/solution','/brief'])('keeps a locked later phase out of %s before child effects start',suffix=>{phase('maintenance','locked');state.path+=suffix;render();expect(host.querySelector('[data-testid=phase-locked]')).not.toBeNull();expect(state.childMount).not.toHaveBeenCalled();expect(state.requirementsMount).not.toHaveBeenCalled();});
 it('does not briefly mount an unknown phase child while the project loads',()=>{state.path+='/design';state.project.loading=true;render();expect(host.querySelector('[data-testid=phase-opening]')).not.toBeNull();expect(state.childMount).not.toHaveBeenCalled();state.project.loading=false;render();expect(host.textContent).toContain('not available in your project');expect(state.childMount).not.toHaveBeenCalled();});
 it('offers local recovery when a missing or locked phase is opened with collapsed navigation',()=>{state.path+='/design';render();expect(host.querySelector('a')?.getAttribute('href')).toBe('/progress');phase('design','locked');state.project.currentPhase={id:'requirements-current',key:'requirements',status:'in_progress'};render();expect(host.querySelector('a')?.getAttribute('href')).toBe('/workspace/requirements-current/interview');expect(host.textContent).toContain('Open current phase');expect(state.childMount).not.toHaveBeenCalled();});
 it('keeps the same Requirements workspace across its three supported entry aliases',()=>{phase('requirements');state.path+='/interview';render();const held=host.querySelector('[data-testid=requirements-persistent]');state.path='/workspace/owned-phase/issue';render();expect(host.querySelector('[data-testid=requirements-persistent]')).toBe(held);state.path='/workspace/owned-phase/brief';render();expect(state.requirementsMount).toHaveBeenCalledTimes(1);});
 it.each(['implementation','testing','deployment','maintenance'])('preserves the existing %s pull request reader',key=>{phase(key);state.path+='/pr';render();expect(state.childMount).toHaveBeenCalledTimes(1);expect(host.querySelector('[data-testid=phase-view-mismatch]')).toBeNull();});
 // A structured phase is worked in its room only: the bare workspace path never shows its documents as files.
 it('sends the bare workspace path of a design-kind phase to the design room, keeping the query, and mounts no IDE',()=>{
  phase('design');state.project.details={'owned-phase':{...(state.project.enrollment.phases[0] as object),design:{contracts:{api:true,screens:false},sequence:false,stories:[],floor:{}}}};state.search='task=t1';render();
  expect(state.replace).toHaveBeenCalledWith('/workspace/owned-phase/design?task=t1');expect(state.childMount).not.toHaveBeenCalled();expect(host.querySelector('[data-testid=design-room-redirect]')).not.toBeNull();
 });
 // A cross-phase evidence door names a task by `?task=` on the bare path: a quiz there opens the quiz, not the room.
 it('sends a quiz key on a design-kind phase straight to that quiz, and the design task key or none to the room',()=>{
  const tasks=[{key:'design',title:'Design',artefactType:'design-doc',required:true},{key:'patterns-quiz',title:'Patterns',artefactType:'quiz',required:true}];
  phase('design');state.project.details={'owned-phase':{...(state.project.enrollment.phases[0] as object),tasks,design:{contracts:{api:true,screens:false},sequence:false,stories:[],floor:{}}}};
  state.search='task=patterns-quiz';render();
  expect(state.replace).toHaveBeenLastCalledWith('/workspace/owned-phase/quiz?task=patterns-quiz');expect(state.childMount).not.toHaveBeenCalled();
  state.search='task=design';render();
  expect(state.replace).toHaveBeenLastCalledWith('/workspace/owned-phase/design?task=design');
  state.search='';render();
  expect(state.replace).toHaveBeenLastCalledWith('/workspace/owned-phase/design');expect(state.childMount).not.toHaveBeenCalled();
 });
 it('keeps the IDE for a Design phase that still grades the markdown kind',()=>{phase('design');state.project.details={'owned-phase':{...(state.project.enrollment.phases[0] as object)}};render();expect(state.replace).not.toHaveBeenCalled();expect(state.childMount).toHaveBeenCalledTimes(1);});
 it('opens the backlog, never the IDE, on the bare workspace path of a story-kind Requirements phase',()=>{
  phase('requirements');state.project.details={'owned-phase':{...(state.project.enrollment.phases[0] as object),story:{id:'US-4',hints:{},floor:{},providedStories:[]},tasks:[]}};render();
  expect(state.requirementsMount).toHaveBeenCalledTimes(1);expect(state.childMount).not.toHaveBeenCalled();
 });
});
