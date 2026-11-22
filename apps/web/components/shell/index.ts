/**
 * The application shell: the chrome every page is drawn in, and the IDE parts
 * the working pages assemble. Import from '@/components/shell': the files
 * behind this barrel are an implementation detail.
 *
 * See ./README.md for each component's props.
 */
export { TopBar } from './TopBar';
export { Sidebar, navKeyFromPath } from './Sidebar';
export { AppFrame, SessionGate } from './AppFrame';
export { ShellProvider, useShell, useShellConfig, useDeclaredGroups } from './ShellProvider';
export type { ShellConfig } from './ShellProvider';
export { BellPanel } from './BellPanel';
export { DocPage } from './DocPage';
export { WorkPage, PhaseStrip } from './WorkPage';
export {
  PersonaPanel,
  // The column over a thread the caller holds, so one conversation
  // can be drawn under two tabs.
  PersonaColumn,
  PersonaHeader,
  PersonaFeed,
  PersonaComposer,
  usePersona,
  explainedTests,
  PERSONA_NAME,
} from './PersonaPanel';
export type { PersonaThread } from './PersonaPanel';
export { Palette } from './Palette';
export { CoachMarks } from './CoachMarks';
export type { CoachMark } from './CoachMarks';
export { Thumb, thumbKind } from './Thumb';
export type { ThumbKind } from './Thumb';
export { ActivityBar, Explorer, BottomPanel, StatusBar, InlineNote } from './ide';
export type { ActivityItem, ExplorerNode, ExplorerChange, ExplorerLine, ExplorerProblem, BottomTab, NoteChoice } from './ide';
export {
  phaseHref,
  phaseDoorHref,
  // The quiz room's own href, and the door that picks between a phase's room
  // and its quiz. They are re-exported here with the other five doors because
  // a reader of this barrel is reading the list of places a phase can open.
  quizHref,
  phaseWorkHref,
  doorWithTasks,
  roomHref,
  briefHref,
  phaseDocHref,
  phaseDocLabel,
  solutionHref,
} from './routes';
export type { PhaseDoor } from './routes';
export { useSignOut } from './useSignOut';
export type { Crumb, NavKey, PaletteItem, PaletteGroup, ShellNav } from './types';
