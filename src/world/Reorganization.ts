import { seedOf } from '../show/rng';
import type { WorldView } from './WorldView';

/**
 * Which configuration a scene's structure settled into after the world's
 * releases. A release (a real drop: stored potential turned into motion) does
 * not only shake a structure: when it has passed, the structure is another
 * one. This keeps the two configurations a scene has to show while that
 * happens (the one before the last release, the one after it) and the age of
 * the release; the scene decides what a configuration is (sides of a section,
 * orders of a lattice …) and how the release carries it from one to the other.
 *
 * The configuration is chosen by the release's own audio time, so it is the
 * same at any frame rate and for any batching, and never the one it replaces.
 * Before the first release of a session it is configuration 0, the canonical
 * one. A reading of the world like WorldView: it keeps no musical state.
 */
export class Reorganization {
  /** Configuration before the last release and after it (whole numbers below `choices`). */
  previous = 0;
  current = 0;
  /** Seconds since the last release (Infinity before any, and without a clock). */
  age = Infinity;
  private seen = -Infinity;
  private lastTime = -Infinity;

  constructor(readonly choices: number, private readonly salt = 0) {}

  update(view: Readonly<WorldView>): void {
    const world = view.world, time = world.releaseTime;
    // A clock that went back is another session: its structure starts from the canonical configuration.
    if (world.time < this.lastTime - 1) this.reset();
    this.lastTime = world.time;
    if (!Number.isFinite(time)) {
      this.age = Infinity;
      return;
    }
    if (time !== this.seen) {
      this.seen = time;
      this.previous = this.current;
      const pick = seedOf(Math.floor(time * 1000), this.salt) % (this.choices - 1);
      this.current = pick >= this.previous ? pick + 1 : pick;
    }
    this.age = Number.isFinite(view.releaseAge) ? Math.max(0, view.releaseAge) : Infinity;
  }

  reset(): void {
    this.previous = this.current = 0;
    this.age = Infinity;
    this.seen = this.lastTime = -Infinity;
  }
}
