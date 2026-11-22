import { ScrollRegion } from '../experience/ScrollRegion';
import type { ChapterStudy, PhaseStudy } from './study';
import { codeFragments } from './figures/CodeText';

/** "TaskTrackr, worked": the worked example drawn as an artefact card, the
 * reasoning steps beside it, why it works, and the chapter's table if any. */
export function WorkedExample({ chapter }: { chapter: ChapterStudy }) {
  return (
    <section className="lesson-study-walkthrough" aria-label="TaskTrackr worked walkthrough">
      <span className="learn-eyebrow">TaskTrackr, worked</span>
      <h3>{chapter.title}</h3>
      <div className="lesson-worked-grid">
        <figure className="lesson-worked-example">
          <figcaption>The worked example</figcaption>
          <pre tabIndex={0} aria-label="The TaskTrackr worked example">{chapter.example}</pre>
        </figure>
        <ol className="lesson-worked-steps">{chapter.steps.map(step => <li key={step}>{codeFragments(step)}</li>)}</ol>
      </div>
      <div className="lesson-study-why"><h4>Why this works</h4><p>{codeFragments(chapter.why)}</p></div>
      {chapter.table && (
        <ScrollRegion className="lesson-study-table" label={chapter.table.caption} hint="Scroll sideways to read every column.">
          <table>
            <caption>{chapter.table.caption}</caption>
            <thead><tr>{chapter.table.headings.map(heading => <th scope="col" key={heading}>{heading}</th>)}</tr></thead>
            <tbody>{chapter.table.rows.map((row, index) => <tr key={index}>{row.map((cell, at) => at === 0 ? <th scope="row" key={at}>{codeFragments(cell)}</th> : <td key={at}>{codeFragments(cell)}</td>)}</tr>)}</tbody>
          </table>
        </ScrollRegion>
      )}
    </section>
  );
}

/** The reveal-your-reasoning exercise: an open question, then the authored
 * reasoning behind a disclosure. */
export function ReasoningExercise({ chapter }: { chapter: ChapterStudy }) {
  return (
    <section className="lesson-transfer-practice" aria-label="Independent reasoning practice">
      <h4>Make the reasoning your own</h4>
      <p>{codeFragments(chapter.practice)}</p>
      <details><summary>Compare your reasoning</summary><p>{codeFragments(chapter.reasoning)}</p></details>
      <small>This is an authored explanation for self-study. Opening it does not evaluate or submit your project.</small>
    </section>
  );
}

export function Takeaway({ chapter }: { chapter: ChapterStudy }) {
  return <p className="lesson-chapter-takeaway"><strong>Keep this idea:</strong> {codeFragments(chapter.takeaway)}</p>;
}

/** The three parts together, in reading order. The reader draws the parts
 * apart (the practice question sits between them); this whole is kept for
 * a caller that wants one block. */
export function StudyWalkthrough({ chapter }: { chapter: ChapterStudy }) {
  return (
    <>
      <WorkedExample chapter={chapter} />
      <ReasoningExercise chapter={chapter} />
      <Takeaway chapter={chapter} />
    </>
  );
}

export function StudyRecap({ study }: { study: PhaseStudy }) {
  return (
    <section className="lesson-study-recap" aria-label="Phase recap and transfer">
      <span className="learn-eyebrow">BRING THE IDEAS TOGETHER</span>
      <h3>What you can now explain</h3>
      <ol>{study.recap.map(item => <li key={item}>{codeFragments(item)}</li>)}</ol>
      <h4>Your next independent step</h4>
      <p>{codeFragments(study.transfer)}</p>
      <p className="lesson-study-optional">Use the phase workspace when you are ready. These lessons and self-checks are optional; advancement depends on your submitted project evidence.</p>
    </section>
  );
}
