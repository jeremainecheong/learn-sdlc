#!/usr/bin/env node
/**
 * The product's voice, enforced.
 *
 * docs/design-system.md and the product brief say the same two things about
 * every word a learner reads: sentence case, and no pipe or middle dot standing
 * in for a word. What the two rules catch looks like "Withheld · I will not
 * write the criterion for you", "3 projects started · 4 mentor hints" and
 * "docs/ · Your user story", or a lowercase sentence fragment set as an error
 * on one page while its sibling page sets a sentence.
 *
 * Two rules, both deliberately narrow so that a green run means something:
 *
 *   1. No `·` and no `|` in JSX text. JSX text is what is drawn: a JsxText node,
 *      a string literal standing alone inside a JSX expression container
 *      ({' · '}), which is the other way a separator reaches the screen, and a
 *      string handed to one of the props the primitives draw as prose (title,
 *      purpose, body, label, hint, aria-label and friends; `placeholder` is not
 *      one of them, because a placeholder often shows the learner the code they
 *      are meant to type, and `date | None` is Python, not a separator). A pipe
 *      in a union type, a regex, a class name or a comment is not copy, and the
 *      TypeScript parser is what tells the two apart: a `>` … `<` scan cannot,
 *      because `Record<K, V>` and `'a' | 'b'` look exactly like copy to it.
 *   2. A message set with setError() starts as a sentence: a capital, a digit or
 *      an opening quote. '' is allowed, because that is clearing the message
 *      rather than writing one, and so is a template that opens with an
 *      interpolation, because what it opens with is not knowable here.
 *
 * Rule 1 also reads every exported string constant (a string or template
 * literal bound by `export const`) in the roots' .ts and .tsx files, because a
 * sentence a component draws is often kept as a named constant beside it and
 * reaches the screen through an identifier the JSX walk cannot follow. `lib/`
 * is not a default root: its exported strings include inline scripts (the
 * theme's boot script), where a pipe is code.
 *
 * An em-dash is not one of the banned separators: the product draws one as the
 * mark of an empty table cell, and a few product sentences (the terms page,
 * the site description) use one as prose.
 *
 * It parses the .tsx with the typescript package already installed, so it
 * needs no runner and no browser.
 *
 * Run: npm run lint:copy -w @learnsdlc/web, or node apps/web/scripts/copy-lint.mjs [root ...]
 * Exit 0 clean, 1 with one finding per line as "path, line n: what and why".
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ts = createRequire(import.meta.url)('typescript');

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOTS = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => resolve(p))
  : [join(HERE, 'app'), join(HERE, 'components')];

/**
 * The props whose value is drawn as prose. Everything else an element carries
 * (className, href, a testid) is machinery, and machinery is allowed a pipe.
 */
const PROSE_PROPS = new Set([
  'title',
  'purpose',
  'body',
  'label',
  'hint',
  'emptyBody',
  'busyLabel',
  'aria-label',
  'alt',
  'summary',
]);

/** The two separators the product does not use in prose. */
const BANNED = [
  { ch: '·', name: 'a middle dot' },
  { ch: '|', name: 'a pipe' },
];

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (full.endsWith('.tsx') || (full.endsWith('.ts') && !full.endsWith('.d.ts'))) out.push(full);
  }
  return out;
}

const findings = [];

for (const root of ROOTS) {
  for (const file of files(root)) {
    const src = readFileSync(file, 'utf8');
    const where = relative(process.cwd(), file);
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

    /** Everything drawn as text by this file, with where it came from. */
    const copy = [];
    const walk = (node) => {
      if (ts.isJsxText(node)) {
        copy.push({ text: node.text, pos: node.getStart(sf) });
      } else if (ts.isJsxExpression(node) && node.expression) {
        const e = node.expression;
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
          copy.push({ text: e.text, pos: e.getStart(sf) });
        }
      } else if (ts.isJsxAttribute(node) && node.initializer) {
        const name = node.name.getText(sf);
        if (PROSE_PROPS.has(name)) {
          const init = node.initializer;
          const value = ts.isStringLiteral(init)
            ? init
            : ts.isJsxExpression(init) &&
                init.expression &&
                (ts.isStringLiteral(init.expression) ||
                  ts.isNoSubstitutionTemplateLiteral(init.expression))
              ? init.expression
              : null;
          if (value) copy.push({ text: value.text, pos: value.getStart(sf) });
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);

    // Exported string constants: `export const NAME = '…'`, a template's literal parts included.
    for (const statement of sf.statements) {
      if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (!init) continue;
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) copy.push({ text: init.text, pos: init.getStart(sf) });
        else if (ts.isTemplateExpression(init)) {
          for (const part of [init.head, ...init.templateSpans.map((span) => span.literal)]) copy.push({ text: part.text, pos: part.getStart(sf) });
        }
      }
    }

    for (const { text, pos } of copy) {
      for (const { ch, name } of BANNED) {
        if (!text.includes(ch)) continue;
        findings.push(
          `${where}, line ${lineOf(pos)}: ${name} is standing in for a word in copy the learner reads. Say the word, or draw a state square.`,
        );
      }
    }

    // setError('…'), including the multi-line call prettier produces.
    const calls = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'setError' &&
        node.arguments.length > 0
      ) {
        const arg = node.arguments[0];
        const literal =
          ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)
            ? arg.text
            : ts.isTemplateExpression(arg)
              ? arg.head.text
              : null;
        // A template whose head is empty opens with its interpolation, and what
        // that resolves to is not knowable here.
        if (literal && /^[a-z]/.test(literal)) {
          findings.push(
            `${where}, line ${lineOf(arg.getStart(sf))}: setError opens in lower case ("${literal.slice(0, 40)}…"). A message the learner reads is a sentence.`,
          );
        }
      }
      ts.forEachChild(node, calls);
    };
    calls(sf);
  }
}

if (findings.length) {
  for (const f of findings) console.error(f);
  console.error(`\n${findings.length} copy problem${findings.length === 1 ? '' : 's'}.`);
  process.exit(1);
}
console.log(`Copy is in the product's voice: ${ROOTS.length} root${ROOTS.length === 1 ? '' : 's'} clean.`);
