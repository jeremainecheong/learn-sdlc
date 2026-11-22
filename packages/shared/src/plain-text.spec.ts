import * as fs from 'fs';
import * as path from 'path';
import { holdsHtmlComment, htmlCommentWarning, isPlainText, markdownKeptWarning, markupOnlyWarning, plainTextNotesOn, plainTextOf, TASK_BRIEF_MAX, withoutHtmlComments } from './index';

const frozen: Record<string, Record<string, string>> = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../apps/api/test/fixtures/plain-text-5.0.0.json'), 'utf8'),
);
const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];
const fixedPoint = (text: string) => expect({ text, again: plainTextOf(plainTextOf(text)) }).toEqual({ text, again: plainTextOf(text) });
// A text of `unit` repeated to the brief's cap (TASK_BRIEF_MAX), `tail` last.
const atCap = (unit: string, tail = '') => unit.repeat(Math.ceil(TASK_BRIEF_MAX / unit.length)).slice(0, TASK_BRIEF_MAX - tail.length) + tail;
// The texts `read` takes 1,000 ms or more on, each with how long it took. A text over the bound is read once more and
// the faster read counts, so one pause of a loaded machine does not fail a case.
const slowOn = (texts: string[], read: (text: string) => unknown = plainTextOf) => texts.flatMap((text) => {
  const timed = () => { const started = performance.now(); read(text); return Math.round(performance.now() - started); };
  let ms = timed();
  if (ms >= 1000) ms = Math.min(ms, timed());
  return ms < 1000 ? [] : [{ text: text.slice(0, 16), length: text.length, ms }];
});

describe('plainTextOf', () => {
  it('keeps code spans and fenced blocks byte for byte, their backticks and fence lines included', () => {
    expect(plainTextOf('Call `list_tasks(conn, list_id)` once.')).toBe('Call `list_tasks(conn, list_id)` once.');
    expect(plainTextOf('```yaml\n- name: build\n  run: npm ci\n```')).toBe('```yaml\n- name: build\n  run: npm ci\n```');
    expect(plainTextOf('```py\ndef day(offset):\n    return (today() + timedelta(days=offset)).isoformat()\n```'))
      .toBe('```py\ndef day(offset):\n    return (today() + timedelta(days=offset)).isoformat()\n```');
  });
  it('turns headings, tables and links into plain lines, and keeps list markers', () => {
    expect(plainTextOf('## Your task\n\n- one\n* two\n1. three\n  2. four')).toBe('Your task\n\n- one\n* two\n1. three\n  2. four');
    expect(plainTextOf('| testid | what |\n|---|:-:|\n| overdue-badge | the late marker |')).toBe('testid; what\noverdue-badge; the late marker');
    expect(plainTextOf('Read [the guide](https://example.org/g) first.')).toBe('Read the guide (https://example.org/g) first.');
  });
  it('removes emphasis only where CommonMark reads it, so words with underscores and asterisks inside stay', () => {
    expect(plainTextOf('**strictly before** and *(US-4)* and _quietly_')).toBe('strictly before and (US-4) and quietly');
    expect(plainTextOf('TASKTRACKR_DB and API_URL, list_tasks and add_comment(conn, task_id, ...)')).toBe('TASKTRACKR_DB and API_URL, list_tasks and add_comment(conn, task_id, ...)');
    expect(plainTextOf('1. **`list_tasks` in `api/repository/tasks.py`** *(US-3)* now')).toBe('1. `list_tasks` in `api/repository/tasks.py` (US-3) now');
    expect(plainTextOf('2 * 3 * 4 and a*b')).toBe('2 * 3 * 4 and a*b');
  });
  it('keeps an asterisk with a letter or digit on both sides, where CommonMark would read emphasis', () => {
    expect(plainTextOf('area = w*h*d and 2*x*y and a*b*c')).toBe('area = w*h*d and 2*x*y and a*b*c');
    expect(plainTextOf('foo**bar**baz')).toBe('foo**bar**baz');
  });
  it('keeps a line indented four spaces exactly, as code', () => {
    expect(plainTextOf('    # set up\n    - kept')).toBe('    # set up\n    - kept');
  });
  it('keeps a backslash escape and its character, and reads neither as a delimiter', () => {
    expect(plainTextOf('\\*x\\* and \\_y\\_ and \\# z')).toBe('\\*x\\* and \\_y\\_ and \\# z');
  });
  it('keeps an HTML comment in the text, converts nothing inside it, and the display removes it', () => {
    const text = 'Before.\n\n<!-- for the teacher: grade the badge -->\n\nAfter.';
    expect(plainTextOf(text)).toBe(text);
    expect(withoutHtmlComments(text)).toBe('Before.\n\nAfter.');
    expect(plainTextOf('A <!-- a *b* c --> B')).toBe('A <!-- a *b* c --> B');
    expect(withoutHtmlComments(plainTextOf('A <!-- a *b* c --> B'))).toBe('A  B');
  });
  it('converts the text before a comment that spans lines and after it closes, never inside it', () => {
    expect(plainTextOf('## Head <!-- a *b*\nstill *in*\n--> after **x**')).toBe('Head <!-- a *b*\nstill *in*\n--> after x');
    expect(isPlainText('**bold** <!-- open\nclose -->')).toBe(false);
  });
  it('keeps every list number, whether it opens a list item or goes on a paragraph', () => {
    expect(plainTextOf('It shipped in\n2024. Since then it grew.')).toBe('It shipped in\n2024. Since then it grew.');
    expect(words(plainTextOf('It shipped in\n2024. Since then it grew.'))).toEqual(['It', 'shipped', 'in', '2024', 'Since', 'then', 'it', 'grew']);
    expect(plainTextOf('Steps:\n\n2. second\n3. third')).toBe('Steps:\n\n2. second\n3. third');
    expect(isPlainText('Bring:\n- milk\n* eggs\n+ tea\n\n1. Open the file\n2) Save it')).toBe(true);
  });
  it('keeps CRLF line endings, splits paragraphs at a CRLF blank line, and is idempotent over them (Review Focus 3)', () => {
    const text = '## Head\r\n\r\n**two**\r\n\tthree';
    expect(plainTextOf(text)).toBe('Head\r\n\r\ntwo\r\n\tthree');
    expect(plainTextOf(plainTextOf(text))).toBe(plainTextOf(text));
  });
  it('returns a text that holds no markdown construct unchanged', () => {
    for (const text of ['Plain words.', 'Line one\nLine two\n\nA second paragraph.', 'TaskTrackr shipped, people use it.']) expect(isPlainText(text)).toBe(true);
  });
  it('is a fixed point over every construct, and gives code back byte for byte on every pass', () => {
    // each a code span or a fence whose content a pass without delimiters would read again
    const code = [
      'Call `__init__` first.', 'Name it `_private_` here.', '`# TODO` marks the gap.', 'Use `[x](y)` syntax.', 'Use `` a ` b `` here.',
      '```sh\n# install\nnpm ci\n```', '```yaml\n- name: build\n  run: npm ci\n```', '```py\nprint(f"{a*b*c}")\n```',
      '```\nunclosed\n# still code\n- still', '~~~\n# tilde\n~~~', '```\n| a | b |\n|---|---|\n```',
    ];
    for (const text of code) { expect(plainTextOf(text)).toBe(text); fixedPoint(text); }
    // A I-A4's property: generated fenced blocks of markdown-looking lines, under every fence, come back whole on each pass
    for (const line of ['# x', '- x', '1. x', 'a*b*c', '__x__', '| a | b |', '**bold**', '[l](u)', '    deep', '<!-- c -->']) {
      for (const fence of ['```', '~~~', '````']) {
        const text = `Before.\n\n${fence}\n${line}\n${line}\n${fence}\n\nAfter **b**.`;
        expect(plainTextOf(text)).toBe(`Before.\n\n${fence}\n${line}\n${line}\n${fence}\n\nAfter b.`);
        fixedPoint(text);
      }
    }
    // constructs a first pass reveals (a heading's emphasised marker, a link inside a link) are taken in the same call
    expect(plainTextOf('**1.** Open the file')).toBe('1. Open the file');
    expect(plainTextOf('*#* x')).toBe('x');
    expect(plainTextOf('- # x')).toBe('- # x');
    expect(plainTextOf('> quoted')).toBe('> quoted');
    for (const text of ['**1.** Open the file', '- # x', '## *1.* step', '*#* x', '*-* x', '*```*', '**a**b', '*a* *b*c', '***a**', '**a*', '*a**b*', '_a_b_',
      '[[a](b)](c)', 'x | y', 'a|b\n---|---\nc|d', 'a\n***\n2. b', 'p\n===\n2. b', '- a\n## H\ntext\n2. b', '\\**a**', '<https://x.org/a_b_c>', '\\*x\\*']) fixedPoint(text);
  });
  it('keeps every word, in order, of every frozen 5.0.0 and Shelf family text, and is idempotent over each', () => {
    let texts = 0;
    for (const [phase, members] of Object.entries(frozen)) {
      for (const [member, text] of Object.entries(members)) {
        texts += 1;
        const plain = plainTextOf(text);
        expect({ phase, member, words: words(plain) }).toEqual({ phase, member, words: words(text) });
        expect({ phase, member, again: plainTextOf(plain) }).toEqual({ phase, member, again: plain });
      }
    }
    expect(texts).toBeGreaterThan(150);
  });
  it('leaves every 5.0.0 Design, Deployment and Maintenance text, every plain brief of the frozen packs and every mentor text, as it is', () => {
    for (const [phase, members] of Object.entries(frozen)) {
      for (const [member, text] of Object.entries(members)) {
        // every mentor prompt and hint is plain, Deployment's one code span with its backticks included
        if (member.startsWith('assistant.')) expect({ phase, member, plain: isPlainText(text) }).toEqual({ phase, member, plain: true });
      }
      // TaskTrackr's Design, Deployment and Maintenance, and the Shelf family's Deployment and Maintenance, which are plain. These are the frozen
      // 5.0.0 texts, where the Shelf family's Design brief is still markdown; every shipped text is plain, and tasktrackr-6.spec holds that
      if (!/(tasktrackr\/phases\/0[256]-(design|deployment|maintenance)|\/phases\/0[56]-(deployment|maintenance))$/.test(phase)) continue;
      for (const [member, text] of Object.entries(members)) expect({ phase, member, plain: isPlainText(text) }).toEqual({ phase, member, plain: true });
    }
  });
  it("keeps the word rule over every older-layout fixture's task.md and phase.json texts, and is idempotent over each", () => {
    const base = path.resolve(__dirname, '../../../apps/api/test/fixtures');
    const visit = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? visit(path.join(dir, entry.name)) : entry.name === 'task.md' || entry.name === 'phase.json' ? [path.join(dir, entry.name)] : []);
    let texts = 0;
    for (const file of visit(base)) {
      const read = fs.readFileSync(file, 'utf8');
      let list: string[] = [read];
      if (file.endsWith('phase.json')) {
        const spec = JSON.parse(read);
        const criteria: { title?: string; description?: string }[] = spec.rubric?.criteria ?? [];
        list = [spec.taskPanel, spec.intro, ...(spec.objectives ?? []), ...criteria.flatMap((c) => [c.title ?? '', c.description ?? ''])].filter((one): one is string => typeof one === 'string');
      }
      for (const text of list) {
        texts += 1;
        expect({ file, words: words(plainTextOf(text)) }).toEqual({ file, words: words(text) });
        fixedPoint(text);
      }
    }
    expect(texts).toBeGreaterThan(300);   // 319 at the base
  });
  it('keeps a private-use U+E000 run as written, whether or not a held piece shares its number', () => {
    for (const text of ['a \u{E000}0\u{E001} *b*', '`c` \u{E000}0\u{E001} *b*', '<!--x--> \u{E000}0\u{E001} *b*']) {
      expect(plainTextOf(text)).toBe(text.replace('*b*', 'b'));
      fixedPoint(text);
    }
  });
  it("keeps a link's or an image's title after its address", () => {
    expect(plainTextOf('See [the guide](https://example.org/g "Read this first") now.')).toBe('See the guide (https://example.org/g "Read this first") now.');
    expect(plainTextOf('![a diagram](d.png "Figure one")')).toBe('a diagram (d.png "Figure one")');
    expect(plainTextOf('[](u "t")')).toBe('u "t"');
  });
  it('shows a text with no comment as it is, and keeps the leading whitespace and line ending after a removed comment', () => {
    expect(withoutHtmlComments('Para\n\n\n    def f():\n        return 1')).toBe('Para\n\n\n    def f():\n        return 1');
    expect(withoutHtmlComments('Before.\n\n<!-- c -->\n\n    indented')).toBe('Before.\n\n    indented');
    expect(withoutHtmlComments('a\r\n\r\n<!-- c -->\r\n\r\nb')).toBe('a\r\n\r\nb');
  });
  it('keeps a comment inside a code span, a fenced block or an indented line on screen, and does not count it', () => {
    expect(withoutHtmlComments('Write `<!-- TODO -->` where it goes.')).toBe('Write `<!-- TODO -->` where it goes.');
    expect(withoutHtmlComments('```html\n<!-- note -->\n<div></div>\n```')).toBe('```html\n<!-- note -->\n<div></div>\n```');
    expect(withoutHtmlComments('Text <!-- a --> here.\n\n    <!-- kept -->')).toBe('Text  here.\n\n    <!-- kept -->');
    expect(holdsHtmlComment('Write `<!-- TODO -->` where it goes.')).toBe(false);
  });
  it('keeps a fenced block opened after a list or block-quote marker byte for byte', () => {
    expect(plainTextOf('- ```py\n  def __init__(self):\n  # comment\n  ```\nafter **b**')).toBe('- ```py\n  def __init__(self):\n  # comment\n  ```\nafter b');
    expect(plainTextOf('> ```py\n> def __init__(self):\n> # comment\n> ```\n\nafter **b**')).toBe('> ```py\n> def __init__(self):\n> # comment\n> ```\n\nafter b');
  });
  it('keeps a line indented four spaces or a tab as it is, markdown-looking text included', () => {
    expect(plainTextOf('    **kwargs and __init__ and [x](y)\n\t__all__ = [a | b]')).toBe('    **kwargs and __init__ and [x](y)\n\t__all__ = [a | b]');
  });
  it('never joins two words where it removes a delimiter', () => {
    for (const text of ['see<https://example.org>now', 'a[b](c)d', 'a[](u)b', 'word![alt](p.png)']) expect(plainTextOf(text)).toBe(text);
    expect(plainTextOf('**bold**_italic_')).toBe('bold_italic_');
    expect(plainTextOf('see <https://example.org> now and [b](c)d')).toBe('see https://example.org now and b (c)d');
    // two conversions side by side read each other, so the second is kept where the first now ends in a word
    expect(plainTextOf('<https://e.org><https://f.org>')).toBe('https://e.org<https://f.org>');
    expect(plainTextOf('[](u)[](v) and ![](p.png)![](q.png)')).toBe('u[](v) and p.png![](q.png)');
  });
  it('converts nothing inside a comment that opens on the line where another closes', () => {
    expect(plainTextOf('<!-- a\nb --> **c** <!-- d\n**e** -->')).toBe('<!-- a\nb --> c <!-- d\n**e** -->');
  });
  it('reads table rows only from a table, never on from a line that holds "; "', () => {
    expect(plainTextOf('Run cat a | grep b; then\nls | wc -l')).toBe('Run cat a | grep b; then\nls | wc -l');
    expect(plainTextOf('| a |\n|---|\n| b |')).toBe('a\nb');
  });
  it('pins the rules no other case holds', () => {
    expect(plainTextOf('Your task\n=========\n\nSteps\n-----\nbody')).toBe('Your task\n\nSteps\nbody');
    expect(plainTextOf('a\n\n---\n\nb')).toBe('a\n\n\n\nb');
    expect(plainTextOf('See ![the board](board.png) here.')).toBe('See the board (board.png) here.');
    expect(plainTextOf('Go to <https://example.org/a_b>.')).toBe('Go to https://example.org/a_b.');
    expect(plainTextOf('## Your task ##\n## C# and F#')).toBe('Your task\nC# and F#');
    expect(plainTextOf('  ## Steps')).toBe('  Steps');
    expect(plainTextOf('````\n```\n# x\n````\n# y')).toBe('````\n```\n# x\n````\ny');
    expect(plainTextOf('```js``` and **b**')).toBe('```js``` and b');
    expect(plainTextOf('It shipped in\n2024. Since\n---')).toBe('It shipped in\n2024. Since');
    expect(plainTextOf('**#*_')).toBe('**#*_');
  });
  it('settles in one pass every emphasis pair whose removal would join two words, so a long line of them is quick', () => {
    const text = '**a**_b_'.repeat(500);   // 4,000 characters: 0cb446b7 took 501 passes and seconds; one sweep takes two passes
    const started = Date.now();
    expect(plainTextOf(text)).toBe('a_b_'.repeat(500));
    expect(Date.now() - started).toBeLessThan(2000);
  });
  // Each construct family at the brief's cap, 20,000 characters, within 1,000 ms: shapes that took a pass
  // a delimiter, a walk over every removed delimiter, or a regular expression that read a long line again from each character.
  it('reads a cap-long line of emphasis within 1,000 ms', () => {
    expect(slowOn([atCap('**a**_b_'), atCap('*a*_b_'), atCap('_a_*b*'), atCap('*a*__b__*c*'), '*'.repeat(9999) + 'ab' + '*'.repeat(9999),
      '_'.repeat(9999) + 'ab' + '_'.repeat(9999), '*a '.repeat(3333) + atCap('b_ ').slice(9999)])).toEqual([]);
  });
  it('reads a cap-long line of links within 1,000 ms', () => {
    expect(slowOn([atCap('[](u)'), atCap('[](u)[x](y)'), atCap('!['), '['.repeat(TASK_BRIEF_MAX - 1) + ']', atCap('[a'), atCap('[[a](b)](c)')])).toEqual([]);
  });
  it('reads a cap-long line of autolinks within 1,000 ms', () => {
    expect(slowOn([atCap('<https://e.org>'), atCap('<https:'), atCap('<')])).toEqual([]);
  });
  it('reads a cap-long line of headings within 1,000 ms', () => {
    expect(slowOn([atCap('## ', 'xx'), atCap('# ', 'xx'), atCap('###### ', 'xx'), atCap('## ', '*a*'), '# a' + ' '.repeat(TASK_BRIEF_MAX - 4) + 'b', atCap('## a\n')])).toEqual([]);
  });
  it('reads a cap-long line of code spans within 1,000 ms', () => {
    const runs = Array.from({ length: 197 }, (_, k) => '`'.repeat(k + 1) + 'a').join('');   // 197 runs, each a length no later run has
    expect(slowOn([atCap('`a`'), atCap('``a`b'), runs + 'b'.repeat(TASK_BRIEF_MAX - runs.length)])).toEqual([]);
  });
  it('reads a cap-long text of lists and quotes within 1,000 ms', () => {
    expect(slowOn([atCap('- ', 'x'), atCap('1. ', 'x'), atCap('> ', 'x'), atCap('- > ', 'x'), atCap('- a\n'), atCap('> **a**\n')])).toEqual([]);
  });
  it('reads and shows a cap-long text of comments within 1,000 ms', () => {
    const texts = [atCap('<!-- a -->'), atCap('<!--'), atCap('<!--\n'), '<!-- c -->\n' + atCap('<!-- x\n').slice(11), atCap('<!-- a\nb -->\n'),
      'a' + ' '.repeat(TASK_BRIEF_MAX - 7) + 'b <!--'];
    expect([slowOn(texts), slowOn(texts, withoutHtmlComments), slowOn(texts, holdsHtmlComment)]).toEqual([[], [], []]);
  });
  it('reads a cap-long table within 1,000 ms', () => {
    expect(slowOn([atCap('| a ', '|').slice(10000) + '\n' + atCap('|---', '|').slice(10001), '| a | b |\n|---|---|\n' + atCap('| c | d |\n').slice(20),
      '| a |\n|---|\n' + atCap('| [](u)[](v) |\n').slice(12), 'a | b\n' + atCap('|---', 'x').slice(6)])).toEqual([]);
  });
  it('reads a cap-long run of setext underlines within 1,000 ms: a pass reads only the lines the last one can have changed', () => {
    const under = (head: string, unit: string) => head + unit.repeat(Math.floor((TASK_BRIEF_MAX - head.length) / unit.length));
    expect(slowOn([under('a\n', '-\n'), under('a\n', '- \n'), under('a\n', '2. a\n-\n'), under('a\n', '*\n=\n'), under('_\n', '# -\n'), under('a\n', '*-*\n')])).toEqual([]);
    expect(plainTextOf('Intro\n-\n-\n-')).toBe('Intro');
    expect(plainTextOf('a\n2. a\n-\n2. a\n-')).toBe('a\n2. a\n2. a');
    expect(plainTextOf('a\n===\n---')).toBe('a\n');
  });
  it('reads a link inside a link, and an autolink inside an autolink, innermost first as CommonMark does, in one pass', () => {
    const nest = (open: string, core: string, close: string) => {
      const k = Math.floor((TASK_BRIEF_MAX - core.length) / (open.length + close.length));
      return open.repeat(k) + core + close.repeat(k);
    };
    expect(slowOn([nest('[', 'a', '](b)'), nest('![', 'a', '](b)'), nest('[x ', 'a', '](b "t")'), nest('<https:', 'x', '>'), nest('<', 'https:x', '>'),
      nest('[<https:', 'x', '>](u)')])).toEqual([]);
    expect(plainTextOf('[[[a](b)](c)](d)')).toBe('a (b) (c) (d)');
    expect(plainTextOf('[a [b](c)')).toBe('[a b (c)');
    expect(plainTextOf('x[[a](b)](c)')).toBe('x[a (b)](c)');
    expect(plainTextOf('<https:<https:x>>')).toBe('https:https:x');
    expect(plainTextOf('<<https://e.org>>')).toBe('https://e.org');
  });
});

describe('the plain-text warnings', () => {
  it('says the one-member sentence for a brief alone, and names every member otherwise', () => {
    expect(markdownKeptWarning('Implementation', ['brief'])).toBe("Implementation's brief had markdown in it. It was kept as plain text, every word in place; read it in the editor.");
    expect(markdownKeptWarning('Implementation', ['objectives', 'brief'])).toBe("Implementation's brief and objectives had markdown in them. They were kept as plain text, every word in place; read them in the editor.");
    expect(markdownKeptWarning('Requirements', ['quiz text'])).toBe("Requirements' quiz text had markdown in it. It was kept as plain text, every word in place; read it in the editor.");
    expect(htmlCommentWarning('Implementation', ['brief'])).toBe("Implementation's brief holds an HTML comment. Learners do not see it; read it in the editor.");
    expect(htmlCommentWarning('Implementation', ['objectives', 'brief'])).toBe("Implementation's brief and objectives hold HTML comments. Learners do not see them; read them in the editor.");
  });

  it("names a draft's ticket lines and story lines after the other members, as plural members", () => {
    expect(markdownKeptWarning('Maintenance', ['ticket lines'])).toBe("Maintenance's ticket lines had markdown in them. They were kept as plain text, every word in place; read them in the editor.");
    expect(markdownKeptWarning('Requirements', ['story lines', 'brief', 'rubric sentences'])).toBe(
      "Requirements' brief, rubric sentences and story lines had markdown in them. They were kept as plain text, every word in place; read them in the editor.",
    );
    expect(htmlCommentWarning('Requirements', ['story lines'])).toBe("Requirements' story lines hold HTML comments. Learners do not see them; read them in the editor.");
  });

  it('says a member that held only markup is now empty, in one sentence for one member and another for several', () => {
    expect(markupOnlyWarning('Implementation', ['brief'])).toBe("Implementation's brief held only markup and is now empty; fill it in.");
    expect(markupOnlyWarning('Requirements', ['quiz text'])).toBe("Requirements' quiz text held only markup and is now empty; fill it in.");
    expect(markupOnlyWarning('Implementation', ['objectives'])).toBe("Implementation's objectives held only markup and are now empty; fill them in.");
    expect(markupOnlyWarning('Testing', ['task title', 'brief'])).toBe("Testing's brief and task title held only markup and are now empty; fill them in.");
    // the note opens with the phase's possessive, so it is read on its phase
    expect(plainTextNotesOn([markupOnlyWarning('Implementation', ['brief'])], 'Implementation')).toEqual([markupOnlyWarning('Implementation', ['brief'])]);
    expect(plainTextNotesOn([markupOnlyWarning('Implementation', ['brief'])], 'Testing')).toEqual([]);
  });

  it('reads the notes that name one phase by its title', () => {
    const notes = [markdownKeptWarning('Requirements', ['brief']), htmlCommentWarning('Implementation', ['brief']), markdownKeptWarning('Implementation', ['objectives'])];
    expect(plainTextNotesOn(notes, 'Implementation')).toEqual([notes[1], notes[2]]);
    expect(plainTextNotesOn(notes, 'Requirements')).toEqual([notes[0]]);
    expect(plainTextNotesOn(notes, 'Design')).toEqual([]);
  });
});
