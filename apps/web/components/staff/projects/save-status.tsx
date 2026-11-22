'use client';

/**
 * The editor's one save status.
 *
 * Every card in the project editor saves on its own (`useCardSave`: when a
 * field is left, or on the card's own button), and each says so in its own
 * line. A teacher who has scrolled away from a card could not see whether it
 * had saved, so each card also reports here, and the section navigation at
 * the top of the editor draws the one line: "Saving…", "Saved", "Not saved:
 * <the card's own sentence>", or the card whose changes have not gone yet and
 * how they will ("Not saved yet: The floor saves when you press Save the floor
 * or leave the card."). A card outside an editor (a test, a preview) reports
 * to nobody.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type EditorSaveState = 'idle' | 'changed' | 'saving' | 'saved' | 'failed';

interface EditorSaveEntry {
  /** The card's title, as the teacher reads it ("The floor"). */
  label: string;
  state: EditorSaveState;
  /** The card's refusal, or the server's sentence, on a failure. */
  message?: string;
  /** How this card's changes go: its own button's name, when it has one. */
  saveButton?: string;
}

type Report = (id: string, entry: EditorSaveEntry | null) => void;

const SaveReport = createContext<Report | null>(null);
const SaveSummary = createContext<string>('');

/** The one line for every card's report, newest concern first. */
export function summariseSaves(entries: readonly EditorSaveEntry[], savedOnce: boolean): string {
  const failed = entries.find((entry) => entry.state === 'failed');
  if (failed) return `Not saved: ${failed.label}. ${failed.message || 'That change could not be saved. Try again in a moment.'}`;
  if (entries.some((entry) => entry.state === 'saving')) return 'Saving…';
  const changed = entries.find((entry) => entry.state === 'changed');
  if (changed)
    return changed.saveButton
      ? `Not saved yet: ${changed.label} saves when you press ${changed.saveButton} or leave the card.`
      : `Not saved yet: ${changed.label} saves when you leave the card.`;
  if (savedOnce || entries.some((entry) => entry.state === 'saved')) return 'Saved';
  return SAVES_AS_YOU_GO;
}

/**
 * The line before anything has been changed. True of a draft, and only of a
 * draft: a published version saves nothing, so the navigation leaves it out
 * there, and the page's own notice says why the version is read-only.
 */
export const SAVES_AS_YOU_GO = 'Every change saves as you make it.';

export function EditorSaveProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, EditorSaveEntry>());
  const [round, setRound] = useState(0);
  const savedOnce = useRef(false);
  const report = useCallback<Report>((id, entry) => {
    const was = entries.current.get(id);
    if (entry === null) {
      if (!was) return;
      entries.current.delete(id);
    } else {
      if (was && was.state === entry.state && was.message === entry.message && was.label === entry.label) return;
      entries.current.set(id, entry);
      if (entry.state === 'saved') savedOnce.current = true;
    }
    setRound((value) => value + 1);
  }, []);
  // Read on every render `round` causes; the string is the context's value, so
  // the navigation redraws only when the line itself changes.
  void round;
  const summary = summariseSaves([...entries.current.values()], savedOnce.current);
  return (
    <SaveReport.Provider value={report}>
      <SaveSummary.Provider value={summary}>{children}</SaveSummary.Provider>
    </SaveReport.Provider>
  );
}

/** The report function, or a no-op outside an editor. */
export function useEditorSaveReport(): Report {
  return useContext(SaveReport) ?? noReport;
}

/** The editor's one line, for the navigation that draws it. */
export function useEditorSaveSummary(): string {
  return useContext(SaveSummary);
}

const noReport: Report = () => undefined;

/** The editor's own saves, told to the one save status from inside its provider. */
export function RunSaveReport({ state, message }: { state: EditorSaveState; message: string }) {
  const report = useEditorSaveReport();
  useEffect(() => {
    report('editor-tasks', { label: "This phase's tasks", state, message });
  }, [report, state, message]);
  return null;
}
