'use client';

/**
 * The React context {@link ProjectProvider} fills with the held project
 * (`lib/useProject`), in a module of its own.
 *
 * Pages read it through `useProject` and `useProjectMaybe`. The gate band reads
 * it here, directly: it needs one fact from the enrolment, whether
 * the learner has already moved on from the phase, and a room mounted without
 * the shell's provider must still draw its band, reading null.
 */
import { createContext } from 'react';
import type { ProjectState } from './useProject';

export const ProjectContext = createContext<ProjectState | null>(null);
