/**
 * A harness-side tolerance for one judge output format: a judge model (Amazon
 * Nova Lite) can end an absolute judgement one closing brace short. Used ONLY on judge calls, after the product's structured() parse has
 * refused the text; candidate outputs never pass through here, so the product
 * path and its strictness are measured as they are.
 *
 * The only repair is appending missing closing brackets at the end, at most 2,
 * and only when the text is not cut inside a string and parses afterwards. A
 * single ```json fence is stripped first, as the product transport does. Any
 * other defect (a preamble, trailing text, a cut string) still fails.
 */
const MAX_APPENDED_CLOSERS = 2;

export function repairJudgeJson(raw: string): { value: unknown; adaptation: string | null } {
  let text = String(raw ?? '').trim();
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*)\n[ \t]*```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  if (!text) throw new Error('judge output is empty');
  try { return { value: JSON.parse(text), adaptation: null }; } catch { /* try the one repair below */ }
  if (!text.startsWith('{')) throw new Error('judge output does not start with a JSON object');
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) throw new Error('judge output has unbalanced brackets');
      if (!stack.length) throw new Error('judge output has text after the JSON object');
    }
  }
  if (inString) throw new Error('judge output is cut inside a string');
  if (!stack.length || stack.length > MAX_APPENDED_CLOSERS) throw new Error('judge output is not JSON');
  const closers = stack.reverse().join('');
  const value = JSON.parse(text + closers);
  return { value, adaptation: `closing-brackets-appended:${closers.length}` };
}
