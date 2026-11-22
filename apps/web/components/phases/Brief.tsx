'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { PhaseDetail, PhaseSummary } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { Button } from '@/components/ui';
import { PHASE_SPEC } from './spec';
import { bridgeApplication, bridgeNotice, kickerName, lessonsOfferedOn, useProjectName } from '@/lib/scenario';
import { useProjectMaybe } from '@/lib/useProject';

/**
 * A phase's intro as its paragraphs: split on blank lines, each trimmed, the
 * empty ones dropped. A Background of several paragraphs (TaskTrackr's
 * Design has six) reads as paragraphs, not one run-on block.
 */
export function introParagraphs(intro:string):string[]{return intro.split(/\n[ \t]*\n/).map(paragraph=>paragraph.trim()).filter(Boolean);}

/**
 * Whether the detail's room is not the reference project's, read off the
 * detail alone (its provenance's room task, as `roomIsReference` reads it
 * first): an uploaded project's, or a copy's whose room task the teacher
 * rewrote. The standing mission line (`PHASE_SPEC.purpose`: "Decide the model,
 * the contracts and one trade-off ...") and the "What it becomes" lines name
 * the reference project's deliverables, so such a room leaves them out and
 * its own intro and objectives say what the phase asks. A detail with no
 * provenance keeps the standing words.
 */
export function roomIsOwn(detail:Pick<PhaseDetail,'provenance'>|null|undefined):boolean{const room=detail?.provenance?.roomTask;return Boolean(room)&&room!=='reference';}

/** The project case file; teaching remains available in the optional catalogue. */
export function Brief({phase,detail,onBegin}:{phase:PhaseSummary;detail:PhaseDetail;onBegin:()=>void}) {
 const [tab,setTab]=useState<'mission'|'evidence'|'review'>('mission');
 // The case file's kicker names the learner's project.
 const named=useProjectName();
 const project=kickerName(named);
 // The bridge notice on the last four phases
 // of a teacher's project, named from the provenance payload.
 const application=bridgeApplication(detail.provenance,useProjectMaybe()?.enrollment);
 // The phase guide teaches the reference project's
 // story, so a phase that is the teacher's own offers no door to it.
 const held=useProjectMaybe();
 const lessons=lessonsOfferedOn(held?.enrollment,phase.key,{...held?.details,[detail.id]:detail});
 const own=roomIsOwn(detail);
 return <div className="phase-case-file" data-testid="brief"><nav aria-label="Case file sections">{(['mission','evidence','review'] as const).map(key=><button key={key} type="button" aria-pressed={tab===key} onClick={()=>setTab(key)}>{key==='mission'?'Your mission':key==='evidence'?'What you will produce':'Review criteria'}</button>)}</nav>
 <div className="phase-case-panel" hidden={tab!=='mission'}><span className="phase-case-kicker">{project} / {phase.key.toUpperCase()}</span>{!own&&<h3>{PHASE_SPEC[phase.key].purpose}</h3>}{introParagraphs(detail.intro).map((paragraph,index)=><p key={index} data-testid="brief-intro">{paragraph}</p>)}{application&&<p className="phase-brief-bridge" role="note" data-testid="brief-bridge-notice">{bridgeNotice(application)}</p>}<ol data-testid="brief-steps">{detail.objectives.map((objective,index)=><li key={index}><span>{index+1}</span><p>{objective}</p></li>)}</ol>{lessons&&<aside data-testid="brief-about"><Icon name="book" size={22}/><div><strong>Learn as you need it.</strong><p>The phase lesson has worked examples, diagrams, and practice. It is optional; you can begin your project now.</p><Link href={`/learn/${phase.key}`}>Open the phase guide <Icon name="arrow-right" size={13}/></Link></div></aside>}</div>
 <div className="phase-case-panel" hidden={tab!=='evidence'} data-testid="brief-deliverables"><h3>Evidence your team can use</h3><p>These are the editable files carried by this phase. Your saved work becomes part of your project’s evidence.</p><ul className="phase-case-files">{detail.files.filter(file=>file.editable).map(file=><li key={file.path}><Icon name="code" size={17}/><div><strong>{file.path.split('/').pop()}</strong><code>{file.path}</code></div></li>)}</ul>{!own&&<><h4>What it becomes</h4>{PHASE_SPEC[phase.key].drawn.map(item=><p key={item.title}><strong>{item.title}:</strong> {item.detail}</p>)}</>}</div>
 <div className="phase-case-panel" hidden={tab!=='review'} data-testid="brief-judged"><h3>Pass or Needs revision</h3><p>Every required criterion needs correct, complete evidence. Revise your work and submit again when feedback identifies a gap.</p><ul className="phase-case-criteria">{detail.rubric.criteria.map(criterion=><li key={criterion.key}><Icon name="check-circle" size={17}/><div><strong>{criterion.title}</strong><p>{criterion.description}</p></div></li>)}</ul><p data-testid="brief-questions">Questions support your reasoning. Your private mentor conversation stays in this project phase.</p></div>
 <footer><span>{lessons?'Begin with the work, or study the optional guide first.':'Begin with the work.'}</span><Button onClick={onBegin} icon="arrow-right" testId="go-to-workspace">Go to the workspace</Button></footer></div>;
}

/**
 * The case file inside the workspace: every door opens the phase's room,
 * so the mission, what the phase produces and the review criteria are read here,
 * in the brief panel, folded under one named control. The same words as the
 * case file page, stacked rather than tabbed (the panel is a narrow column),
 * without the bridge notice, which the panel's intro already draws above it,
 * and without the page's "What it becomes" lines, which name the reference
 * project's own files (ci.yml, CR-1) and so cannot stand in a teacher's room.
 * The room passes its own detail and whether it offers the phase guide (the
 * strip's `lessonsOfferedOn`); nothing is drawn before the detail has arrived.
 * Where the panel's intro card stands above the fold (`introCard`, every room
 * but the reference Implementation room's five-task panel) and the intro is the
 * teacher's own, the card already draws it (`usePhaseOwnIntro`: the held
 * detail's provenance says `intro: 'own'`), so the fold leaves it out rather
 * than read it twice. The fold reads that fact off the detail it is handed,
 * not through the project hook, so it stays a pure function of its props; the
 * reference project's intro is never "own" and stays.
 *
 * `folded={false}` draws the same sections without a fold of their own, for a
 * room that puts them inside its one brief fold (the Design room).
 */
export function MissionDetails({phase,detail:mission,lessons,introCard=true,folded=true}:{phase:Pick<PhaseSummary,'key'>;detail?:PhaseDetail|null;lessons:boolean;introCard?:boolean;folded?:boolean}) {
 if(!mission)return null;
 const introAbove=introCard&&mission.provenance?.intro==='own'&&Boolean(mission.intro?.trim());
 // A room of its own reads no standing mission line (`roomIsOwn`); where the
 // intro is drawn above and it holds no objectives either, the mission
 // section has nothing to say and is left out.
 const own=roomIsOwn(mission);
 // A held detail can be partial (an older payload, a summary read): what it
 // lacks is left out, never a reason for the room to fail.
 const objectives=mission.objectives??[];
 const files=(mission.files??[]).filter(file=>file.editable);
 const criteria=mission.rubric?.criteria??[];
 const head='text-[13px] font-semibold text-ink';
 const body='mt-1.5 text-[12.5px] leading-[1.65] text-ink2';
 const sections=<>
  {(!own||!introAbove||(mission.objectives??[]).length>0||lessons)&&<section className="py-3" data-testid="phase-mission-mission"><h3 className={head}>Your mission</h3>{!own&&<p className={body}>{PHASE_SPEC[phase.key].purpose}</p>}{!introAbove&&introParagraphs(mission.intro??'').map((paragraph,index)=><p key={index} className={body}>{paragraph}</p>)}{objectives.length>0&&<ol className="mt-2 list-decimal pl-5 text-[12.5px] leading-[1.65] text-ink2">{objectives.map((objective,index)=><li key={index}>{objective}</li>)}</ol>}{lessons&&<p className={body}><Link className="font-semibold text-accent underline" href={`/learn/${phase.key}`}>Open the phase guide</Link> (optional)</p>}</section>}
  {files.length>0&&<section className="border-t-1.5 border-edge py-3" data-testid="phase-mission-produce"><h3 className={head}>What you will produce</h3><ul className="mt-1.5 text-[12.5px] leading-[1.65] text-ink2">{files.map(file=><li key={file.path}><code className="wrap">{file.path}</code></li>)}</ul></section>}
  <section className="border-t-1.5 border-edge py-3" data-testid="phase-mission-review"><h3 className={head}>Review criteria</h3><p className={body}>Pass or Needs revision. Every required criterion needs correct, complete evidence.</p><ul className="mt-1.5">{criteria.map(criterion=><li key={criterion.key} className={body}><strong className="text-ink">{criterion.title}</strong>: {criterion.description}</li>)}</ul></section>
 </>;
 return folded
  ?<details className="phase-contract-detail" data-testid="phase-mission"><summary>Mission and review criteria</summary>{sections}</details>
  :<div className="mt-3 border-t-1.5 border-edge" data-testid="phase-mission">{sections}</div>;
}
export default Brief;
