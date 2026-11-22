'use client';
import { useEffect, useState } from 'react';

export const AGENT_ROOM_UNSAVED = 'learnsdlc:agent-room-unsaved';
/**
 * Whether the room holds an edit not yet saved, by phase: the room says so as
 * its save state moves, and a record proposal's Apply waits while it does
 * (Apply stays locked while a form has an unsaved edit). Kept here
 * too, so a conversation opened after the room spoke still knows.
 */
const roomUnsaved = new Map<string, boolean>();
export function announceRoomUnsaved(phaseId: string, unsaved: boolean) {
 if (roomUnsaved.get(phaseId) === unsaved) return;
 roomUnsaved.set(phaseId, unsaved);
 window.dispatchEvent(new CustomEvent<{ phaseId: string; unsaved: boolean }>(AGENT_ROOM_UNSAVED, { detail: { phaseId, unsaved } }));
}
export function useRoomUnsaved(phaseId: string | undefined): boolean {
 const [unsaved, setUnsaved] = useState(() => Boolean(phaseId && roomUnsaved.get(phaseId)));
 useEffect(() => {
  setUnsaved(Boolean(phaseId && roomUnsaved.get(phaseId)));
  const said = (event: Event) => { const detail = (event as CustomEvent<{ phaseId: string; unsaved: boolean }>).detail; if (detail.phaseId === phaseId) setUnsaved(detail.unsaved); };
  window.addEventListener(AGENT_ROOM_UNSAVED, said);
  return () => window.removeEventListener(AGENT_ROOM_UNSAVED, said);
 }, [phaseId]);
 return unsaved;
}
