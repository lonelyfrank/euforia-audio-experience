import type { Domain } from '../core/DiagnosticsTypes';
import type { WorkspaceView } from './components';

/**
 * Every block the inspector can hold. A component builds its blocks and says which section each one is; the view
 * alone says which sections are shown (`VIEW_SECTIONS`), through one function (`applySections`). No component hides or
 * shows itself, and hiding is presentation only: what a hidden block measures keeps being collected and sampled.
 */
export type Section =
  /** The six registry measures with their last ten seconds: frame pacing, CPU, GPU, draw calls, clock. */
  | 'health'
  | 'overview'
  /** Audio & Analysis panels (DEV). */
  | 'audio'
  /** The view's canvas of readings (DEV): Experience, World, Matter. */
  | 'charts'
  /** Temporary overrides and the laboratories' entries (DEV). */
  | 'experiment'
  /** The running laboratory's own inspector (DEV). */
  | 'laboratory'
  /** Domain choice, pause, freeze, reset, Detailed, GPU profiling, readback. */
  | 'acquisition'
  | 'plot'
  /** The registry's rows for the view's domains. */
  | 'registry'
  /** Primitive isolation and the parity proofs (DEV). */
  | 'isolation'
  | 'replay'
  | 'reports'
  | 'timeline';

export const VIEW_SECTIONS: Record<WorkspaceView, readonly Section[]> = {
  overview: ['overview', 'health'],
  audio: ['audio', 'registry'],
  experience: ['charts', 'registry', 'timeline'],
  world: ['charts', 'plot', 'registry'],
  matter: ['charts', 'registry'],
  render: ['health', 'plot', 'registry'],
  laboratories: ['experiment', 'laboratory', 'isolation'],
  diagnostics: ['acquisition', 'plot', 'registry', 'isolation', 'replay', 'reports', 'timeline'],
};

/** The registry domains a view reads. Diagnostics & Reports has none of its own: there the domain is chosen. */
export const VIEW_DOMAINS: Record<WorkspaceView, readonly Domain[] | null> = {
  overview: ['render'], audio: ['audio'], experience: ['experience'], world: ['world', 'physics'], matter: ['matter', 'geometry'],
  render: ['render'], laboratories: ['matter'], diagnostics: null,
};

/** What `applySections` writes: an element (whose `hidden` may also hold the DOM's `until-found`), or anything with a `hidden`. */
export interface SectionTarget { hidden: boolean | string }
/** One block and the sections it holds: a panel has one, a container (a shadow host) all of those inside it. */
export interface Block { readonly target: SectionTarget; readonly sections: readonly Section[] }
export const block = (target: SectionTarget, ...sections: Section[]): Block => ({ target, sections });

/** The one place where the inspector's blocks are shown or hidden: a block shows when the view asks for any of its sections. */
export function applySections(view: WorkspaceView, blocks: Iterable<Block>): void {
  const shown = VIEW_SECTIONS[view];
  for (const { target, sections } of blocks) {
    const hidden = !sections.some(section => shown.includes(section));
    if (target.hidden !== hidden) target.hidden = hidden;
  }
}
