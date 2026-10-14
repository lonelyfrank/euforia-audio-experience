import type { OverrideLedger } from '../core/Overrides';

/**
 * The laboratories, each with its own inspector; one runs at a time. Structural Lab and Solid Dynamics pin the viewport's
 * world; Musical Cognition runs synthetic feature sequences beside the live engine and touches nothing of it.
 */
export type Laboratory = 'structural' | 'solid' | 'cognition';
export const LABS: Record<Laboratory, string> = { structural: 'Structural Lab', solid: 'Solid Dynamics', cognition: 'Musical Cognition' };

/** What a running laboratory gives the experiment: how many of its own overrides are in force, and how it ends (its pin and overrides go back). */
export interface RunningLab { readonly overrides: number; dispose(): void }

/**
 * The life of an experiment, apart from its controls and from the view that shows them:
 *
 * - **open** enters a laboratory: the one already running is reused as it is, another one is ended first;
 * - a **change of view** is not an operation here: nothing of the experiment follows the inspector;
 * - **stop** ends the laboratory and gives every temporary override back, and can be asked again;
 * - **dispose** is the last stop: nothing opens afterwards.
 *
 * Closing the workspace stops the experiment and then disposes of it.
 */
export class Experiment {
  private lab: RunningLab | null = null;
  private name: Laboratory | null = null;
  private disposed = false;
  /**
   * @param requested The laboratory an entry opens when none is running: the one a start parameter named, then the last one opened.
   * @param ledger Holds the overrides that are not a laboratory's own (isolation, Matter form, tunnel, test signal).
   */
  constructor(private readonly create: (lab: Laboratory) => RunningLab, private requested: Laboratory, private readonly ledger: OverrideLedger) {}

  get running(): Laboratory | null { return this.name; }
  /** Overrides in force: the running laboratory's own and those in the ledger. What stopping gives back. */
  get overrides(): number { return (this.lab?.overrides ?? 0) + this.ledger.size; }

  /** Enters a laboratory; without a name, the one running or the one last asked for. True when a laboratory was started. */
  open(lab: Laboratory = this.name ?? this.requested): boolean {
    if (this.disposed) return false;
    this.requested = lab;
    if (this.name === lab) return false;
    // The one leaving gives its pin and its overrides back first: the next one starts from the product's state, and restores the same.
    this.end();
    this.lab = this.create(lab); this.name = lab;
    return true;
  }

  stop(): void {
    this.end();
    this.ledger.releaseAll('stop experiment');
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
  }

  private end(): void {
    const lab = this.lab;
    this.lab = null; this.name = null;
    lab?.dispose();
  }
}
