'use client';

import { useState } from 'react';
import type { WorkspaceFile } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { scrollFocusRef } from '@/lib/scroll-focus';
import { REFERENCE_IMPLEMENTATION_TASKS } from './reference/implementation-tasks';

const TASKS = REFERENCE_IMPLEMENTATION_TASKS;

export function ImplementationTaskPanel({ files, focusedName, onOpen }: { files: WorkspaceFile[]; focusedName?: string; onOpen: (path: string, line: number) => void }) {
  const [chosen, setChosen] = useState(0);
  const [tab, setTab] = useState<'brief' | 'contract' | 'examples'>('brief');
  const cursorTask = TASKS.findIndex(task => task.name === focusedName);
  const index = cursorTask < 0 ? chosen : cursorTask;
  const task = TASKS[index];
  const choose = (next: number) => {
    setChosen(next);
    const target = TASKS[next];
    const content = files.find(file => file.path === target.file)?.content ?? '';
    const line = content.split('\n').findIndex(row => new RegExp(`(?:def|function)\\s+${target.name}\\b`).test(row));
    onOpen(target.file, Math.max(1, line + 1));
  };
  return <aside className="implementation-brief task-assignment" aria-label="Requirements and contracts">
    <header><Icon name="doc" size={16} /><strong>Your task</strong><span>{index + 1} of {TASKS.length}</span></header>
    <label className="task-picker">Choose a task<select value={index} onChange={event => choose(Number(event.target.value))}>{TASKS.map((item, i) => <option key={item.name} value={i}>{String(i + 1).padStart(2, '0')}: {item.name}</option>)}</select></label>
    <nav className="task-assignment-tabs" aria-label="Task information">{(['brief','contract','examples'] as const).map(item => <button key={item} type="button" aria-pressed={tab===item} onClick={() => setTab(item)}>{item[0].toUpperCase()+item.slice(1)}</button>)}</nav>
    <div ref={scrollFocusRef} className="task-assignment-content"><small>{task.story}</small><h2>{task.title}</h2><p>{tab === 'contract' ? task.contract : task.brief}</p>
      <h3><Icon name="map" size={15}/>Follow the change</h3><ol className="task-flow">{task.steps.map((step,i)=><li key={step}><span>{i+1}</span>{step}</li>)}</ol>
      {tab !== 'brief' && <p>{task.contract}</p>}
      <h3><Icon name="code" size={15}/>Expected result <span>Example</span></h3><p className="task-example-label">{task.case}</p><pre>{task.example}</pre>
      <p className="task-evidence-note">These examples describe the contract. Run your saved work to collect execution evidence.</p>
    </div>
    <footer><button type="button" aria-label="Previous implementation task" disabled={index===0} onClick={()=>choose(index-1)}><Icon name="arrow-left" size={16}/></button><span>Explore the five gaps</span><button type="button" aria-label="Next implementation task" disabled={index===TASKS.length-1} onClick={()=>choose(index+1)}><Icon name="arrow-right" size={16}/></button></footer>
  </aside>;
}
