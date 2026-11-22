/**
 * `source` with `span` replaced by `replacement`, when `span` occurs exactly
 * once; a throw otherwise.
 *
 * The authored twins of the reference prompts are built this way so they
 * differ from TaskTrackr's only where declared. Every twin is built at module
 * load, so if the span a twin rewrites ever moves or repeats, the API stops at
 * load rather than shipping a twin that silently equals the reference. `what`
 * names the prompt in the error. Keep the throw; the parity specs catch it
 * long before a build does.
 */
export function replaceSpanOnce(source: string, span: string, replacement: string, what: string): string {
  const at = source.indexOf(span);
  if (at < 0 || source.indexOf(span, at + 1) >= 0) {
    throw new Error(`authored prompt twin: the span it rewrites in ${what} does not occur exactly once`);
  }
  return source.slice(0, at) + replacement + source.slice(at + span.length);
}
