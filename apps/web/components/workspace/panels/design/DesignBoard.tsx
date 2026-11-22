'use client';

/**
 * The design's surroundings: the parts down the left, the contradictions and
 * the drawings on the Review tab, and the state the room is in when the
 * record cannot be opened.
 *
 * Every piece here is a view over {@link useDesign}. Nothing fetches: the
 * record comes in, the writers go out.
 */
import { useMemo } from 'react';
import { CellTitle, Chip, Notice, Panel, SectionHead, StatusSquare, Table } from '@/components/ui';
import { apiEndpoints, numberWord, screenRows, type Design } from '@learnsdlc/shared';
import { ClassDiagram } from './ClassDiagram';
import { baseName } from './model';
import { contractWarnings, storyFacts } from './contradictions';
import type { DesignState } from './useDesign';

/**
 * Small counts read as words in the parts list ("Six entities", not "6
 * entities"). Numerals stay where they are a measurement.
 */
export const count = (n: number) => numberWord(n, 12);
export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const n = (k: number, one: string, many: string) => `${count(k)} ${k === 1 ? one : many}`;

/* ---------------------------------------------------------------------------
   Drift against the code.
--------------------------------------------------------------------------- */

/** Files that could hold the operations, once the Implementation phase has written them. */
const CODE_PATH = /(manager|taskmanager)\.(py|js|ts|mjs)$/i;
const PY_DEF = /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm;
const JS_FN = /^[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?(?:function[ \t]+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)[ \t]*\([^)]*\)[ \t]*\{)/gm;
/** Control-flow keywords the JS pattern would otherwise read as a definition. */
const RESERVED = new Set(['if', 'for', 'while', 'switch', 'catch', 'constructor', 'return']);

/**
 * Function names defined in a manager file the workspace happens to carry.
 * Dunders and private helpers are not part of a design, so they never count
 * as drift.
 */
function codeFunctions(files: Record<string, string>): { path: string; names: string[] } | null {
  const path = Object.keys(files)
    .filter((p) => CODE_PATH.test(p))
    .sort()[0];
  if (!path) return null;
  const text = files[path] ?? '';
  const names = new Set<string>();
  const collect = (re: RegExp) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const name = m[1] || m[2];
      if (name && !name.startsWith('_') && !RESERVED.has(name)) names.add(name);
    }
  };
  collect(PY_DEF);
  if (/\.(js|ts|mjs)$/i.test(path)) collect(JS_FN);
  return { path, names: [...names] };
}

/** Functions the code defines that no operation names. Empty is "no drift"; null is "no code yet". */
export function designDrift(doc: Design, files: Record<string, string>): { path: string; names: string[] } | null {
  const found = codeFunctions(files);
  if (!found) return null;
  const named = new Set(doc.operations.map((op) => baseName(op.name).toLowerCase()));
  return { path: found.path, names: found.names.filter((name) => !named.has(name.toLowerCase())) };
}

/** The parts list's line for a component diagram with no module in this phase's files to draw it from. */
export const COMPONENTS_NOTHING_TO_DRAW = 'Nothing in this phase to draw it from';
/** The Review tab's panel, the same fact in a sentence. */
export const COMPONENTS_NONE_HERE =
  "Drawn from the imports of the modules in this phase's files, and this phase holds none. The code is written in Implementation, in its own files.";
/** The class diagram's drift line where this phase holds no code to compare it with. */
export const DRIFT_NONE_HERE = 'No file in this phase defines the operations, so there is nothing to compare the diagram with.';

/**
 * The component diagram reads Python modules only. A Design phase whose files carry code in another language (no
 * shipped project does) has code, so "this phase holds none" would be false there: it gets these words instead.
 * A phase with no code at all, every shipped Design, keeps the words above.
 */
export const COMPONENTS_PYTHON_ONLY = 'Drawn from Python modules only';
export const COMPONENTS_NOT_PYTHON =
  'Drawn from the imports of Python modules. The code in this phase is in another language, so there is nothing to draw.';
const OTHER_CODE = /\.(ts|tsx|js|jsx|mjs)$/i;
/** Code in this phase's files that is not Python (tests left out, as the diagram leaves them out). */
function otherCodeHere(files: Record<string, string>): boolean {
  return Object.keys(files).some((p) => OTHER_CODE.test(p) && !p.includes('test'));
}
/**
 * The drift line where this phase holds code but no manager file, the only file the diagram is compared with: "no
 * file defines the operations" could be false there.
 */
export const DRIFT_NO_MANAGER = 'The diagram is compared with a manager file, such as task_manager.py, and this phase holds none.';
function codeHere(files: Record<string, string>): boolean {
  return otherCodeHere(files) || Object.keys(files).some((p) => p.endsWith('.py') && !p.includes('test'));
}

/** The modules this project is made of, and what each one imports. */
function componentNodes(files: Record<string, string>) {
  const py = Object.keys(files)
    .filter((p) => p.endsWith('.py') && !p.includes('test'))
    .sort();
  return py.slice(0, 4).map((path) => {
    const imports = (files[path] ?? '')
      .split('\n')
      .filter((l) => /^\s*(from|import)\s/.test(l))
      .map((l) => l.trim().split(/\s+/)[1])
      .filter((x): x is string => Boolean(x));
    const local = imports.filter((x) => py.some((p) => p.endsWith(`${x.split('.').pop()}.py`)));
    return {
      path,
      note: local.length
        ? `imports ${Array.from(new Set(local)).join(', ')}`
        : `${imports.length} ${imports.length === 1 ? 'import' : 'imports'}`,
    };
  });
}

/* ---------------------------------------------------------------------------
   The left column: what the design is made of, counted from the record.
--------------------------------------------------------------------------- */

export function DesignParts({
  design,
  files = {},
}: {
  design: DesignState;
  /** The workspace, for the parts that are drawn from code rather than written. */
  files?: Record<string, string>;
}) {
  const { doc, contracts, apiText, screensText } = design;
  const drift = designDrift(doc, files);
  const modules = componentNodes(files).length;
  const attributes = doc.entities.reduce((sum, e) => sum + e.attributes.filter((a) => a.name.trim()).length, 0);
  const accepted = doc.decisions.filter((d) => d.status === 'accepted').length;
  const proposed = doc.decisions.filter((d) => d.status === 'proposed').length;
  const endpoints = apiEndpoints(apiText).length;
  const screens = screenRows(screensText).length;
  // Presence only (written or not yet), never the floor's verdict: a written part is 'done', never a green pass.
  const parts: { state: 'done' | 'warn' | 'todo'; title: string; detail: string }[] = [
    {
      state: doc.entities.length ? 'done' : 'todo',
      title: 'Data model',
      detail: doc.entities.length
        ? sentence(`${n(doc.entities.length, 'entity', 'entities')}, ${n(attributes, 'attribute', 'attributes')}`)
        : 'No entities yet',
    },
    {
      state: doc.relations.length ? 'done' : 'todo',
      title: 'Relations',
      detail: doc.relations.length ? sentence(n(doc.relations.length, 'relation', 'relations')) : 'No relations yet',
    },
    {
      state: doc.operations.length ? 'done' : 'todo',
      title: 'Operations',
      detail: doc.operations.length ? sentence(n(doc.operations.length, 'operation', 'operations')) : 'No operations yet',
    },
    ...(contracts.api
      ? [{
          state: (endpoints ? 'done' : 'todo') as 'done' | 'todo',
          title: 'API contract',
          detail: endpoints ? sentence(n(endpoints, 'endpoint', 'endpoints')) : 'No endpoints yet',
        }]
      : []),
    ...(contracts.screens
      ? [{
          state: (screens ? 'done' : 'todo') as 'done' | 'todo',
          title: 'Screens',
          detail: screens ? sentence(n(screens, 'screen', 'screens')) : 'No screens yet',
        }]
      : []),
    {
      // A decision nobody accepted is still a proposal, so the parts list says which it is.
      state: accepted > 0 ? 'done' : doc.decisions.length ? 'warn' : 'todo',
      title: 'Decisions',
      detail: accepted > 0
        ? sentence(`${count(accepted)} accepted${proposed > 0 ? `, ${count(proposed)} proposed` : ''}`)
        : proposed > 0
          ? sentence(`${count(proposed)} proposed`)
          : doc.decisions.length
            ? sentence(n(doc.decisions.length, 'decision', 'decisions'))
            : 'Not written',
    },
    {
      state: !drift ? 'done' : drift.names.length ? 'warn' : 'done',
      title: 'Class diagram',
      detail: !drift ? 'Drawn from your record' : drift.names.length ? sentence(`${count(drift.names.length)} not named`) : 'Drawn, no drift',
    },
    {
      // Drawn from the modules in this phase's own files. A Design workspace that holds none never gets them (the
      // Implementation phase writes its code in its own workspace), so "Waiting on the modules" would never end.
      state: modules ? 'done' : 'todo',
      title: 'Component diagram',
      detail: modules ? 'Drawn from the imports' : otherCodeHere(files) ? COMPONENTS_PYTHON_ONLY : COMPONENTS_NOTHING_TO_DRAW,
    },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <SectionHead title="Your design" purpose="What the review reads, and what the platform drew from it." />
      <Table
        cols={[{ label: 'Part' }]}
        minWidth={200}
        rowTestId={(i) => `phase-design-part-${parts[i].title.toLowerCase().replace(/\s+/g, '-')}`}
        rows={parts.map((p) => [<CellTitle key={p.title} state={p.state} title={p.title} detail={p.detail} />])}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   The contradictions.
--------------------------------------------------------------------------- */

/**
 * Advisory, always. Nothing here blocks a submission, and nothing here
 * announces itself to a screen reader, because six warnings speaking while a
 * learner types is worse than none. The section is a landmark instead.
 */
export function Contradictions({
  design,
  ownRecord,
  onOpen,
}: {
  design: DesignState;
  /** The learner's own story record from the Requirements phase (`useOwnStoryRecord`), when the project has one. */
  ownRecord: string | undefined;
  /** Shows the form with this test id; the operations live on another tab. */
  onOpen?: (testId: string) => void;
}) {
  // The stories the Design phase lists, then the learner's own record.
  const facts = useMemo(() => storyFacts(design.stories, ownRecord), [design.stories, ownRecord]);
  const warnings = useMemo(() => contractWarnings({ design: design.doc, facts }), [design.doc, facts]);
  const storiesMissing = facts.length === 0;
  const scrollTo = (base: string) => {
    const at = design.doc.operations.findIndex((o) => baseName(o.name) === base);
    // an operation renamed since the warning was drawn has no row to open
    if (at < 0) return;
    const testId = `design-operation-${at}`;
    if (onOpen) onOpen(testId);
    else document.querySelector(`[data-testid="${testId}"]`)?.scrollIntoView({ block: 'center' });
  };
  return (
    <section aria-label="Contradictions" className="flex min-w-0 flex-col gap-2.5" data-testid="phase-design-contradictions">
      <SectionHead
        title="Contradictions"
        purpose="Where an operation says the opposite of a story you accepted, or of itself. Nothing here blocks a submission."
        right={warnings.length > 0 ? <Chip tone="warn">{sentence(`${count(warnings.length)} to settle`)}</Chip> : undefined}
      />
      {warnings.length === 0 ? (
        <p className="label-sm wrap" data-testid={storiesMissing ? 'phase-design-no-stories' : 'phase-design-no-contradictions'}>
          {storiesMissing
            ? 'This phase lists no stories and your story record is not here, so only the operations are checked against each other.'
            : 'Nothing in the operations contradicts a story you accepted.'}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {warnings.map((w) => (
            // `role="note"` on purpose: a warn Notice is a live region by default.
            <Notice key={w.id} tone="warn" role="note" testId={`phase-design-warning-${w.id}`}>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="wrap">{w.text}</span>
                <span className="wrap label-sm">
                  You wrote: <span className="text-ink">“{w.said}”</span>
                </span>
                <span className="wrap label-sm">
                  {w.criterionId ?? 'The same operation'}: <span className="text-ink">“{w.against}”</span>
                </span>
                <button
                  type="button"
                  className="btn-ghost btn-sm self-start"
                  data-testid={`phase-design-warning-${w.id}-open`}
                  onClick={() => scrollTo(w.operation)}
                >
                  Open the operation
                </button>
              </div>
            </Notice>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------------
   The two drawings, and the drift under them.
--------------------------------------------------------------------------- */

export function DrawnSection({
  design,
  files,
  id = 'design-drawings',
}: {
  design: DesignState;
  files: Record<string, string>;
  id?: string;
}) {
  const { doc } = design;
  const drift = designDrift(doc, files);
  const nodes = componentNodes(files);
  return (
    <div className="flex min-w-0 scroll-mt-4 flex-col gap-2.5" id={id}>
      <SectionHead
        title="Drawn from your design"
        purpose="Neither is drawn by hand. The class diagram comes from the model and the operations; the components come from the imports."
        right={
          <Chip tone={!drift ? 'neutral' : drift.names.length ? 'warn' : 'pass'}>
            {!drift ? 'Nothing to compare' : drift.names.length ? `${drift.names.length} not named` : 'No drift'}
          </Chip>
        }
      />
      <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel className="flex flex-col gap-3 p-3.5">
          <span className="label-sm">Class diagram</span>
          <ClassDiagram doc={doc} codePath={drift?.path ?? null} apiContract={design.contracts.api} testId="phase-design-diagram" />
          {!drift ? (
            <p className="label-sm wrap">{codeHere(files) ? DRIFT_NO_MANAGER : DRIFT_NONE_HERE}</p>
          ) : drift.names.length === 0 ? (
            <p className="label-sm wrap">Every function in {drift.path} is named by an operation.</p>
          ) : (
            <ul className="m-0 list-none p-0" data-testid="phase-design-drift">
              {drift.names.map((name) => (
                <li
                  key={name}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-t-1.5 border-edge py-2 first:border-t-0"
                  data-testid={`phase-design-drift-${name}`}
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <StatusSquare state="warn" className="mt-[3px]" />
                    <div className="min-w-0">
                      <p className="mono wrap font-medium text-ink">{name}</p>
                      <p className="label-sm wrap mt-0.5">Defined in {drift.path}, named by no operation.</p>
                    </div>
                  </div>
                  <Chip tone="warn">Drift</Chip>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel className="flex flex-col gap-3 p-3.5" testId="phase-design-components">
          <span className="label-sm">Component diagram</span>
          {nodes.length === 0 ? (
            <p className="label-sm wrap">{otherCodeHere(files) ? COMPONENTS_NOT_PYTHON : COMPONENTS_NONE_HERE}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {nodes.map((node, i) => (
                <li key={node.path} className="flex flex-col gap-1.5">
                  <span className="flex items-start gap-2 rounded-ctl border-1.5 border-edge2 px-2.5 py-2">
                    <span className="mt-[3px] h-4 w-1 shrink-0 rounded-sm bg-[rgb(var(--c-accent))]" />
                    <span className="flex min-w-0 flex-col">
                      <span className="mono wrap text-[12px] font-semibold text-ink">{node.path}</span>
                      <span className="wrap text-[12px] text-muted">{node.note}</span>
                    </span>
                  </span>
                  {i < nodes.length - 1 && <span className="ml-3 h-3 w-[1.5px] shrink-0 bg-edge2" aria-hidden />}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   The state the room is in when the record cannot be opened.
--------------------------------------------------------------------------- */

export function DesignUnavailable({ design }: { design: DesignState }) {
  if (!design.broken) return null;
  return (
    <Notice tone="fail" testId="phase-design-unavailable">
      Your design cannot be opened: {design.broken}. It is kept exactly as it was saved, and nothing here writes over it.
      Ask your teacher to reset its starting point.
    </Notice>
  );
}
