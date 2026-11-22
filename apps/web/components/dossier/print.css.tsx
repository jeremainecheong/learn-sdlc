/**
 * The print block, shared by the completion record and the dossier.
 *
 * There is no PDF library anywhere in this product. The browser's own print
 * engine is the pipeline, which is why this file exists: printing is a
 * stylesheet, and a stylesheet nobody can see while they work is a stylesheet
 * that rots. It is one exported string, imported by both pages, so a change to
 * how this deployment prints happens once.
 *
 * Three things in here are load-bearing and none of them are obvious.
 *
 * The palette is restated as RGB triplets under both themes, so a learner
 * reading in Graphite still prints dark ink on white: a printer given a dark
 * page either floods the sheet or, on most default settings, drops the
 * background and leaves pale text on white.
 *
 * `print-color-adjust: exact` is what keeps the verdict language. Every status
 * square and every chip in this product is a filled shape; without the
 * property (and its `-webkit-` twin, which Chrome and Safari still want)
 * they print as empty outlines and the document loses the difference between
 * passed and failed.
 *
 * `break-inside: avoid` belongs on panels and not on code. A three-hundred
 * line file that may not break is a file the engine clips at the page edge, so
 * the code blocks opt back out and only their headings hold on to what
 * follows.
 */

/** The palette, the hidden chrome and the page-break rules every print shares. */
export const PRINT_CSS = `
@media print {
  :root, :root[data-theme="graphite"], :root[data-theme="paper"] {
    --c-ground: 255 255 255; --c-surface: 255 255 255; --c-raised: 238 240 243;
    --c-edge: 227 230 235; --c-edge2: 203 208 216;
    --c-code: 255 255 255; --c-codeline: 240 242 246;
    --c-ink: 17 24 39; --c-ink2: 63 70 83; --c-muted: 107 114 128; --c-dim: 156 163 175;
  }
  /* The shell carries print-hide, so the bar and the sidebar go; the record
     is what is left. */
  .print-hide { display: none !important; }
  main { max-width: none !important; padding: 0 !important; }
  .panel { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
  /* Without this every filled square and chip prints as an empty outline and
     the document loses its whole verdict language. */
  [data-state], .chip, .panel { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

/**
 * The dossier's own additions: it is a document rather than a card, so the
 * column is the page, code is allowed to run over a page break, and the action
 * row at the top is furniture.
 */
export const DOSSIER_PRINT_CSS = `${PRINT_CSS}
@media print {
  .exp-dossier-page { --exp-ink: #111827 !important; --exp-muted: #3f4653 !important; --exp-card: #fff !important; --exp-line: #e3e6eb !important; color: #111827 !important; background: #fff !important; }
  .exp-dossier-page .dossier > section { background: #fff !important; box-shadow: none !important; backdrop-filter: none !important; }
  .dossier { gap: 0 !important; }
  /* Chromium can clip descendants when a screen flex/grid panel fragments
     across printed pages. Use document flow and actual CSS table layout so
     later journal rows and explanatory paragraphs reach the PDF. */
  .dossier, .dossier .flex-col { display: block !important; }
  .dossier .flex-col > * + * { margin-top: .75rem; }
  .dossier .flex-col > span { display: block; }
  .dossier .panel { border-width: 1px; break-inside: auto; overflow: visible !important; }
  .dossier .overflow-hidden, .dossier .overflow-x-auto { overflow: visible !important; }
  .dossier [role="table"] { display: table !important; table-layout: auto; width: 100%; min-width: 0 !important; }
  .dossier [role="row"] { display: table-row !important; break-inside: avoid; }
  .dossier [role="row"]:first-child { break-after: avoid; }
  .dossier [role="cell"], .dossier [role="columnheader"] { display: table-cell !important; vertical-align: top; overflow-wrap: break-word; }
  .dossier [role="columnheader"] { white-space: nowrap; }
  .dossier [data-testid^="dossier-day-"] [role="row"] > :nth-child(1) { width: 64px; white-space: nowrap; }
  .dossier [data-testid^="dossier-day-"] [role="row"] > :nth-child(2) { width: 76px; white-space: nowrap; }
  .dossier [role="cell"] { padding-top: .65rem; padding-bottom: .65rem; }
  .dossier [role="row"] > * + * { margin-top: 0 !important; }
  .dossier [role="cell"] .flex-col > * + * { margin-top: .125rem; }
  /* A long file must be allowed to break, or the engine clips it at the page
     edge and the rest of the listing is simply gone. */
  .dossier-code, .dossier-code pre, .dossier-scroll { break-inside: auto; overflow: visible !important; }
  .dossier-scroll { max-height: none !important; }
  .dossier-section { break-before: auto; }
  /* The cover is page one on its own: everything after it starts fresh. */
  .dossier-section + .dossier-section { break-before: page; }
}
`;

/**
 * The stylesheet, in a way both renders agree on.
 *
 * `<style>{CSS}</style>` looks harmless and costs the dossier its whole
 * hydration. React escapes a text child on the server, so
 * `:root[data-theme="graphite"]` is served as
 * `:root[data-theme=&quot;graphite&quot;]`; `<style>` is a raw-text element,
 * so the parser never decodes those entities. The served rule is invalid and
 * its DOM text differs from the string React renders in the browser, so every
 * load throws hydration errors and React rebuilds the document client-side.
 * `dangerouslySetInnerHTML` is the supported way to put a stylesheet in a
 * page, and the "dangerous" half does not apply: the argument is a module
 * constant in this repository, never anything a learner typed.
 */
export function PrintStyle({ css = PRINT_CSS }: { css?: string }) {
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}
