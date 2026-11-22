export interface DiagramMessage { from: string; to: string; label: string; reply: boolean }
export interface ParsedDiagram { participants: string[]; messages: DiagramMessage[]; errors: string[] }
/** A deliberately small editable grammar, rendered as escaped SVG text by React. */
export function parseSequence(source: string): ParsedDiagram {
 const participants: string[] = []; const messages: DiagramMessage[] = []; const errors: string[] = [];
 source.split('\n').forEach((line, i) => {
  if (!line.trim() || line.trim().startsWith('#')) return;
  const match = /^\s*([\w .-]+?)\s*(--?>)\s*([\w .-]+?)\s*:\s*(.+?)\s*$/.exec(line);
  if (!match) { errors.push(`Line ${i + 1}: use Sender -> Receiver: message (or --> for a reply).`); return; }
  const [, from, arrow, to, label] = match;
  if (from === to) { errors.push(`Line ${i + 1}: self calls are not supported; use a distinct participant.`); return; }
  for (const actor of [from, to]) if (!participants.includes(actor)) participants.push(actor);
  messages.push({ from, to, label, reply: arrow === '-->' });
 });
 if (participants.length > 8) errors.push('Use at most eight participants in one diagram.');
 if (messages.length > 30) errors.push('Use at most thirty messages in one diagram.');
 return { participants: participants.slice(0, 8), messages: messages.slice(0, 30), errors };
}
