/** The laboratories: each a development world with its own inspector. One runs at a time (each pins the viewport's world). */
export type Laboratory = 'structural' | 'solid';
export const LABS: Record<Laboratory, string> = { structural: 'Structural Lab', solid: 'Solid Dynamics' };

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
   * @param restore Gives back the overrides that are not a laboratory's own.
   */
  constructor(private readonly create: (lab: Laboratory) => RunningLab, private requested: Laboratory, private readonly restore: () => void) {}

  get running(): Laboratory | null { return this.name; }
  /** The running laboratory's own overrides. */
  get overrides(): number { return this.lab?.overrides ?? 0; }

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
    this.restore();
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
