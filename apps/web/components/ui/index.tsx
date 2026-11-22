'use client';

/**
 * Shared accessible primitives for the cyan/glass design. Semantic
 * colours and control states live in CSS; pages compose these with the
 * illustrations and familiar tool layouts that give each phase its identity.
 */
export { Chip, StatusSquare, STATUS_WORD, Stat, Readout } from './status';
export type { Tone } from './status';
export { prefetchable, Breadcrumbs } from './navigation';
export { useTabs, useEdgeFade, useDialogFocus } from './hooks';
export type { TabsKeyboard } from './hooks';
export { Panel, Section, EmptyState, Steps, Divider, Detail, SectionHead } from './layout';
export { PhaseTile, PhaseLine, PhaseMark } from './phase-marks';
export { Avatar, initialsOf } from './Avatar';
export { Kbd } from './Kbd';
export { Notice } from './Notice';
export { Button } from './Button';
export { Table, CellTitle } from './Table';
export type { Column } from './Table';
export { Tabs, tabPanelProps } from './Tabs';
