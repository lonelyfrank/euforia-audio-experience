/**
 * The one authority over the temporary overrides of the development switches (`worldLab.only`, `matterLab.form`,
 * `tunnelLab.balance`, the test signal). Whoever wants one asks here, under a key; nobody else writes those switches.
 *
 * The value an override replaces is taken once, when its key is first overridden, and given back once, when the key
 * is released: a second release finds nothing to give back, so two owners can never restore the same state one after
 * the other. Releasing is asked by the experiment when it stops and, at the latest, by the diagnostics when their last
 * user leaves; hiding a control releases nothing.
 *
 * A laboratory's own state (its tuning, its pinned world) is not here: the laboratory takes it when it starts and
 * gives it back when it ends.
 */
export class OverrideLedger {
  private readonly held = new Map<string, { original: unknown; restore: () => void }>();
  /** Told after every change of what is in force, with who asked for it. */
  onChange: ((key: string, origin: string) => void) | null = null;

  /** Overrides in force. */
  get size(): number { return this.held.size; }
  has(key: string): boolean { return this.held.has(key); }

  /** Overrides a property. Its first value is remembered once; writing that value back ends the override. */
  set<T extends object, K extends keyof T>(key: string, target: T, property: K, value: T[K], origin = 'workspace'): void {
    const entry = this.held.get(key);
    if (entry ? Object.is(value, entry.original) : Object.is(value, target[property])) {
      if (!entry) return;
      this.held.delete(key);
    } else if (!entry) {
      const original = target[property];
      this.held.set(key, { original, restore: () => { target[property] = original; } });
    }
    target[property] = value;
    this.onChange?.(key, origin);
  }

  /** An override that is not a property: `restore` undoes it. The first one under a key is kept, later ones are the same override. */
  hold(key: string, restore: () => void, origin = 'workspace'): void {
    if (!this.held.has(key)) this.held.set(key, { original: undefined, restore });
    this.onChange?.(key, origin);
  }

  /** Gives one override back. False when the key held nothing: releasing again changes nothing. */
  release(key: string, origin = 'workspace'): boolean {
    const entry = this.held.get(key);
    if (!entry) return false;
    this.held.delete(key);
    entry.restore();
    this.onChange?.(key, origin);
    return true;
  }

  releaseAll(origin = 'workspace'): void {
    for (const key of [...this.held.keys()]) this.release(key, origin);
  }
}
