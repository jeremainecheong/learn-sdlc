// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OnboardingPage from '@/app/(app)/onboarding/page';
// `active` is the slug the tab happens to be holding: the previous account's,
// on a shared machine. It is deliberately a fixture slug and not the shipped
// pack's, because a test written against "tasktrackr" would pass just as
// happily against a slug hard-coded in the page. The assertions below say this
// page never sends it. See `shared-machine-project.test.tsx` for the whole
// exchange.
const mocks = vi.hoisted(() => ({ enroll: vi.fn(), request: vi.fn(), join: vi.fn(), replace: vi.fn(), setSession: vi.fn(), remembered: vi.fn(), active: 'ledger', classroom: vi.fn(), leave: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/lib/session', () => ({ useSession: () => ({id:'setup-user',displayName:'Learner',avatar:0,profileVersion:3}), setSession: mocks.setSession, onSessionEnd: () => () => undefined }));
vi.mock('@/lib/api', () => ({ api: {enroll:mocks.enroll}, request:mocks.request, describeError: (e: Error) => e.message }));
vi.mock('@/lib/api-cohorts', () => ({cohortsApi:{join:mocks.join}}));
vi.mock('@/lib/api-experience', () => ({experienceApi:{classroom:mocks.classroom,leave:mocks.leave}}));
vi.mock('@/lib/project', () => ({ getActiveProject: () => mocks.active, setActiveProject: mocks.remembered }));
vi.mock('@/lib/useProject', () => ({invalidateProject: vi.fn()}));
let host: HTMLDivElement; let root: Root;
beforeEach(() => { vi.clearAllMocks(); mocks.active='ledger'; mocks.classroom.mockResolvedValue(null); mocks.leave.mockResolvedValue({left:true}); host=document.createElement('div');document.body.append(host);root=createRoot(host);act(()=>root.render(<OnboardingPage/>)); });
afterEach(()=>{act(()=>root.unmount());host.remove();});
const submit=()=>act(async()=>{fireEvent.submit(host.querySelector('form')!);});

it('keeps setup incomplete after enrollment failure, then preserves the chosen portrait through retry', async()=>{
  mocks.enroll.mockRejectedValueOnce(new Error('Project setup unavailable. Retry.')).mockResolvedValueOnce({projectSlug:'ledger'});
  mocks.request.mockResolvedValue({id:'setup-user',displayName:'Learner',avatar:2,profileVersion:4,onboardingCompleted:true});
  act(()=>host.querySelectorAll<HTMLButtonElement>('.onboarding-avatars button')[2].click());
  await submit();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Retry');
  expect(host.querySelectorAll('.onboarding-avatars button')[2].getAttribute('aria-pressed')).toBe('true');
  await submit();
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith('PATCH','/account/profile',{displayName:'Learner',avatar:2,onboardingCompleted:true,baseVersion:3});
  expect(mocks.enroll.mock.invocationCallOrder[1]).toBeLessThan(mocks.request.mock.invocationCallOrder[0]);
  expect(mocks.replace).toHaveBeenCalledWith('/dashboard');
});

/**
 * Which project setup enrols into, and, more to the point, who decides.
 *
 * Neither a shipped slug written out here nor the slug `lib/project` holds for
 * the tab: both would be this page answering a question only the server can
 * answer, and the second answers it with the *previous account's* project on
 * a shared machine. So the request names nothing: the server resolves the
 * learner's class assignment, or the
 * project this deployment starts everybody on, and this page remembers what it
 * was told.
 */
it('lets the server name the project, and never the one the tab is holding', async()=>{
  mocks.enroll.mockResolvedValue({projectSlug:'tasktrackr'});
  mocks.request.mockResolvedValue({id:'setup-user',displayName:'Learner',avatar:0,profileVersion:4,onboardingCompleted:true});
  await submit();
  expect(mocks.enroll).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.enroll).not.toHaveBeenCalledWith('ledger');
  // And the tab is put straight, so the shell opens on the project this
  // learner was actually given rather than on what it was holding.
  expect(mocks.remembered).toHaveBeenCalledWith('tasktrackr');
  expect(mocks.replace).toHaveBeenCalledWith('/dashboard');
});

it("shows the server's own sentence when it refuses, and leaves setup unfinished", async()=>{
  const refusal = 'Nothing was started, because that project is not one this account can start; your dashboard opens the project that is yours.';
  mocks.enroll.mockRejectedValue(new Error(refusal));
  await submit();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(refusal);
  expect(host.querySelector<HTMLButtonElement>('.onboarding-submit')!.disabled).toBe(false);
});

/**
 * "Learn independently" means the project for learners without a class.
 *
 * A learner who joined a class (through an invitation link, or on this form
 * before an enrolment failed) and then chooses to learn on their own is still
 * a member, so the server would resolve the class's project for them (perhaps
 * a teacher's). So the solo branch asks whether this account is in a class
 * and leaves it first; the server then starts the default.
 */
it('leaves the class this account is in before it starts independently', async()=>{
  mocks.classroom.mockResolvedValue({id:'class-a',name:'A class',joinCode:'ABCDEFGH',createdAt:'',memberCount:1});
  mocks.enroll.mockResolvedValue({projectSlug:'tasktrackr'});
  mocks.request.mockResolvedValue({id:'setup-user',displayName:'Learner',avatar:0,profileVersion:4,onboardingCompleted:true});
  await submit();
  expect(mocks.leave).toHaveBeenCalledTimes(1);
  expect(mocks.leave.mock.invocationCallOrder[0]).toBeLessThan(mocks.enroll.mock.invocationCallOrder[0]);
  expect(mocks.enroll).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.join).not.toHaveBeenCalled();
  expect(mocks.replace).toHaveBeenCalledWith('/dashboard');
});

it('leaves nothing when the account is in no class', async()=>{
  mocks.enroll.mockResolvedValue({projectSlug:'tasktrackr'});
  mocks.request.mockResolvedValue({id:'setup-user',displayName:'Learner',avatar:0,profileVersion:4,onboardingCompleted:true});
  await submit();
  expect(mocks.classroom).toHaveBeenCalledTimes(1);
  expect(mocks.leave).not.toHaveBeenCalled();
  expect(mocks.enroll).toHaveBeenCalledExactlyOnceWith();
});

it('neither asks about nor leaves a class when the learner is joining one', async()=>{
  mocks.join.mockResolvedValue({id:'class-b'});
  mocks.enroll.mockResolvedValue({projectSlug:'library-desk'});
  mocks.request.mockResolvedValue({id:'setup-user',displayName:'Learner',avatar:0,profileVersion:4,onboardingCompleted:true});
  act(()=>{ (host.querySelector('input[value="class"]') as HTMLInputElement).click(); });
  act(()=>{ fireEvent.change(host.querySelector('#onboarding-class-code')!, {target:{value:'ABCDEFGH'}}); });
  await submit();
  expect(mocks.join).toHaveBeenCalledExactlyOnceWith('ABCDEFGH');
  expect(mocks.leave).not.toHaveBeenCalled();
  expect(mocks.join.mock.invocationCallOrder[0]).toBeLessThan(mocks.enroll.mock.invocationCallOrder[0]);
});

it('does not start anything when leaving the class fails, and says so', async()=>{
  mocks.classroom.mockResolvedValue({id:'class-a',name:'A class',joinCode:'ABCDEFGH',createdAt:'',memberCount:1});
  mocks.leave.mockRejectedValue(new Error('Your class could not be left. Try again.'));
  await submit();
  expect(mocks.enroll).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Your class could not be left.');
});

/** Learners do not all get the same project, so the page does not say they do. */
it('says what each way of learning starts, rather than that every learner gets the same project', ()=>{
  const text = host.querySelector('.onboarding-path')?.textContent ?? '';
  expect(text).not.toContain('Every learner gets the same project');
  expect(text).toContain('On your own, you start the project for learners without a class.');
  expect(text).toContain('A class may be on a project its teacher chose');
});

/**
 * What joining a class later does.
 *
 * A class that works on another project opens that project next. The project
 * started here is set aside, never deleted and never re-pinned, and it stays
 * in the learner's record. A class with no project of its own, or one on this
 * project, keeps the learner where they are. So the sentence depends on the
 * class working on another project, and it must not say "If you join a class
 * later, you keep this project."
 */
it('says what joining a class that works on another project does, and that the work here stays', ()=>{
  const text = host.querySelector('.onboarding-path')?.textContent ?? '';
  expect(text).not.toContain('Join a class later if you want.');
  expect(text).not.toContain('you keep this project');
  expect(text).toContain(
    'If you later join a class that works on another project, your dashboard opens that one next, and your work on this one stays in your record.',
  );
});
