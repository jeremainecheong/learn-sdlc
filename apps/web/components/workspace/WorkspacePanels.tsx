'use client';

import { useCallback, useContext, useId, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { getSession, useSession } from '@/lib/session';
import { ChatExpansionContext } from '@/components/chat/ChatSurface';
import { AreaRowCompact } from './area-row-fit';
import './WorkspacePanels.css';

type PanelName = 'brief' | 'mentor';
type Preferences = { briefOpen?: boolean; mentorOpen?: boolean };
type CachedPreferences = { raw: string | null; value: Preferences; memoryOnly: boolean };
const STORAGE_PREFIX = 'lsdlc_workspace_panels:';
/** From this width the brief opens by default (phase-experience.css lays the room out for it there). */
const BRIEF_OPEN_MIN_WIDTH = 1440;
/** From this width the mentor opens by default; narrower, the room's columns stack (phase-experience.css at 1024 px). */
const MENTOR_OPEN_MIN_WIDTH = 1024;
const preferences = new Map<string, CachedPreferences>();
const listeners = new Set<() => void>();
const emptyPreferences: Preferences = {};

function parsePreferences(raw: string | null): Preferences {
  if (!raw) return emptyPreferences;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyPreferences;
    const record = value as Record<string, unknown>;
    if (record.version !== 1) return emptyPreferences;
    return {
      ...(typeof record.briefOpen === 'boolean' ? { briefOpen: record.briefOpen } : {}),
      ...(typeof record.mentorOpen === 'boolean' ? { mentorOpen: record.mentorOpen } : {}),
    };
  } catch { return emptyPreferences; }
}

function readPreferences(owner: string | null): Preferences {
  if (!owner || typeof window === 'undefined') return emptyPreferences;
  const existing = preferences.get(owner);
  // A denied write must not be replaced with an older persisted value.
  if (existing?.memoryOnly) return existing.value;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + owner);
    if (existing && raw === existing.raw) return existing.value;
    const value = parsePreferences(raw);
    preferences.set(owner, { raw, value, memoryOnly: false });
    return value;
  } catch { return existing?.value ?? emptyPreferences; }
}

function snapshot(owner: string | null): number {
  const value = readPreferences(owner);
  const width = typeof window === 'undefined' ? 0 : window.innerWidth;
  return ((value.briefOpen ?? width >= BRIEF_OPEN_MIN_WIDTH) ? 1 : 0) | ((value.mentorOpen ?? width >= MENTOR_OPEN_MIN_WIDTH) ? 2 : 0);
}
const serverSnapshot = () => 0;
const notify = () => listeners.forEach(listener => listener());
function storageChanged(event: StorageEvent) {
  if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) notify();
}
function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener('resize', notify);
    window.addEventListener('storage', storageChanged);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('resize', notify);
      window.removeEventListener('storage', storageChanged);
    }
  };
}
function setPreference(owner: string | null, panel: PanelName, update: SetStateAction<boolean>) {
  // A callback from an outgoing account cannot modify the incoming account.
  if (!owner || getSession()?.id !== owner) return;
  const current = snapshot(owner);
  const field = panel === 'brief' ? 'briefOpen' : 'mentorOpen';
  const previous = Boolean(current & (panel === 'brief' ? 1 : 2));
  const next = typeof update === 'function' ? update(previous) : update;
  const value = { ...readPreferences(owner), [field]: next };
  const raw = JSON.stringify({ version: 1, ...value });
  let memoryOnly = false;
  try { window.localStorage.setItem(STORAGE_PREFIX + owner, raw); }
  catch { memoryOnly = true; }
  preferences.set(owner, { raw, value, memoryOnly });
  notify();
}

export interface WorkspacePanelsState {
  briefOpen: boolean;
  mentorOpen: boolean;
  setBriefOpen: Dispatch<SetStateAction<boolean>>;
  setMentorOpen: Dispatch<SetStateAction<boolean>>;
  briefId: string;
  mentorId: string;
}

/** Preferences belong to the learner, persist across phase routes, and never hold project data. */
export function useWorkspacePanels(): WorkspacePanelsState {
  const owner = useSession()?.id ?? null;
  const getSnapshot = useCallback(() => snapshot(owner), [owner]);
  const visible = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
  const id = useId();
  const setBriefOpen = useCallback<Dispatch<SetStateAction<boolean>>>(update => setPreference(owner, 'brief', update), [owner]);
  const setMentorOpen = useCallback<Dispatch<SetStateAction<boolean>>>(update => setPreference(owner, 'mentor', update), [owner]);
  return { briefOpen: Boolean(visible & 1), mentorOpen: Boolean(visible & 2), setBriefOpen, setMentorOpen, briefId: `${id}-brief`, mentorId: `${id}-mentor` };
}

/** Expanding is an explicit choice to keep this mentor visible. Unlike the
 * responsive initial defaults, that choice must survive zoom and reflow so a
 * native modal never remains active inside a hidden ancestor. */
export function WorkspaceMentorBoundary({ panels, onExpand, children }: {
  panels: WorkspacePanelsState;
  onExpand?: () => void;
  children: ReactNode;
}) {
  const owner = useSession()?.id ?? null;
  const { setMentorOpen } = panels;
  const keepVisible = useCallback(() => {
    if (!owner || getSession()?.id !== owner) return;
    setMentorOpen(true);
    onExpand?.();
  }, [owner, setMentorOpen, onExpand]);
  return <ChatExpansionContext.Provider value={keepVisible}>{children}</ChatExpansionContext.Provider>;
}

/**
 * Keep this toolbar outside both panels, so either one can always be reopened.
 *
 * `placement="strip"` is the work room's: the two switches at the right end of
 * the centre column's view tabs rather than a row of their own. Same
 * buttons, same names, same stored preference.
 */
export function WorkspacePanelControls({ panels, onReveal, placement = 'row', mentorNote }: { panels: Pick<WorkspacePanelsState, 'briefOpen' | 'mentorOpen' | 'setBriefOpen' | 'setMentorOpen' | 'briefId' | 'mentorId'>; onReveal?: (panel: PanelName) => void; placement?: 'row' | 'strip'; /** A visible word beside the mentor switch, read as its description (the Requirements room: "Optional"). */ mentorNote?: 'Optional' }) {
  const BriefIcon = panels.briefOpen ? PanelLeftClose : PanelLeftOpen;
  const MentorIcon = panels.mentorOpen ? PanelRightClose : PanelRightOpen;
  const reveal = (panel: PanelName) => {
    if (onReveal) { onReveal(panel); return; }
    if (window.innerWidth < MENTOR_OPEN_MIN_WIDTH) {
      const panelId = panel === 'brief' ? panels.briefId : panels.mentorId;
      window.requestAnimationFrame(() => document.getElementById(panelId)?.scrollIntoView({ block: 'nearest' }));
    }
  };
  const briefWord = panels.briefOpen ? 'Hide brief' : 'Show brief';
  const mentorWord = panels.mentorOpen ? 'Hide mentor' : 'Show mentor';
  // At the right end of a working-area row that is too narrow for its entries and these words, the switches
  // drop their words from view (the row says so: `AreaRowCompact`). Each keeps its icon, its accessible name (the
  // word stays in the button, hidden from view only) and a `title`, and both stay on the row.
  const strip = placement === 'strip';
  const compact = useContext(AreaRowCompact) && strip;
  const word = (text: string) => (strip ? <span className="workspace-panel-word">{text}</span> : text);
  return <div className={`workspace-panel-controls${strip ? ' workspace-panel-controls-strip' : ''}`} role="group" aria-label="Workspace panels" data-compact={compact ? 'true' : undefined}>
    <button type="button" aria-expanded={panels.briefOpen} aria-controls={panels.briefId} title={compact ? briefWord : undefined} onClick={() => { panels.setBriefOpen(!panels.briefOpen); if (!panels.briefOpen) reveal('brief'); }}><BriefIcon size={16} aria-hidden="true" />{word(briefWord)}</button>
    <button type="button" aria-expanded={panels.mentorOpen} aria-controls={panels.mentorId} aria-describedby={mentorNote ? `${panels.mentorId}-note` : undefined} title={compact ? mentorWord : undefined} onClick={() => { panels.setMentorOpen(!panels.mentorOpen); if (!panels.mentorOpen) reveal('mentor'); }}><MentorIcon size={16} aria-hidden="true" />{word(mentorWord)}{mentorNote && <span id={`${panels.mentorId}-note`} aria-hidden="true" className="chip chip-outline workspace-panel-note" data-testid="mentor-note">{mentorNote}</span>}</button>
  </div>;
}
