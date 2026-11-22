"use client";

import { useState, type CSSProperties } from "react";
import { formatJoinCode } from "@/lib/api-cohorts";

/**
 * A class join code, masked until asked for.
 *
 * A join code lets anyone into the class, and the teacher pages are shown on
 * shared screens and projectors. So the code is drawn as a mask of the same
 * shape (`••••-••••`) until the teacher presses **Show code**, and **Copy
 * code** puts the formatted code on the clipboard without showing it. Before
 * the reveal the code is in no text node, aria label, title or data attribute:
 * only the button handlers hold it.
 *
 * The reveal is this component's own state: one code shown leaves every other
 * code masked, and nothing is stored, so a reload masks it again.
 *
 * Test ids (e2e helpers rely on them): `join-code` (the `<code>`),
 * `join-code-show` (Show code / Hide code, with aria-pressed) and
 * `join-code-copy` (Copy code).
 */

/** The code's shape with every character hidden: `••••-••••` for an 8-character code. */
export function maskJoinCode(code: string): string {
  return formatJoinCode(code).replace(/[^-]/g, "•");
}

const ROW: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 };
const COMPACT_CODE: CSSProperties = { display: "inline-block", fontSize: 13, padding: "4px 9px", letterSpacing: "0.08em" };
const COMPACT_BUTTON: CSSProperties = { minHeight: 32, padding: "5px 10px" };

export function JoinCode({ code, compact = false }: { code: string; compact?: boolean }) {
  const [shown, setShown] = useState(false);
  const [status, setStatus] = useState("");

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(formatJoinCode(code));
      setStatus("Copied.");
    } catch {
      setStatus("Could not copy. Use Show code instead.");
    }
  }

  return (
    <div className="exp-join-code" style={ROW}>
      <code className="exp-code" data-testid="join-code" style={compact ? COMPACT_CODE : undefined}>
        {shown ? formatJoinCode(code) : maskJoinCode(code)}
      </code>
      <button
        type="button"
        className="exp-button"
        data-testid="join-code-show"
        aria-pressed={shown}
        style={compact ? COMPACT_BUTTON : undefined}
        onClick={() => setShown((value) => !value)}
      >
        {shown ? "Hide code" : "Show code"}
      </button>
      <button
        type="button"
        className="exp-button"
        data-testid="join-code-copy"
        style={compact ? COMPACT_BUTTON : undefined}
        onClick={() => void copy()}
      >
        Copy code
      </button>
      <span role="status" className="exp-caption">
        {status}
      </span>
    </div>
  );
}
