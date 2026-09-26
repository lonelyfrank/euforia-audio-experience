import { SILENCE_DB } from '../analysis/Smoother';

/** Fully audible down to this far below the recent level (dB): ordinary dynamics never dim anything. */
const FULL_BELOW = 18;
/** Gone this far below the recent level (dB): the visual fade ends as the tail becomes inaudible. */
const GONE_BELOW = 42;
/** The recent level falls back this fast (dB/s) after a loud moment… */
const REFERENCE_FALL = 1.5;
/** …and faster in silence, so a quiet sound after a long pause is still seen. */
const SILENT_FALL = 4;

/**
 * How audible a region is right now compared with its own recent level.
 * It follows the raw level: a fade makes it fall at the fade's own speed, a
 * hard cut makes it drop at once, and any attack brings it back immediately.
 * A drop only shows after `hold` seconds, so the gaps between hits of a
 * percussive part don't flicker (callers lengthen it for percussive regions).
 * Frame-rate independent, allocation-free.
 */
export class Audibility {
  value = 0;
  private reference = Number.NEGATIVE_INFINITY;
  private lowFor = 0;

  update(db: number, dt: number, hold: number): number {
    let target = 0;
    if (db > SILENCE_DB) {
      if (!Number.isFinite(this.reference)) this.reference = db;
      this.reference = Math.max(db, this.reference - REFERENCE_FALL * dt);
      target = smoothstep(this.reference - GONE_BELOW, this.reference - FULL_BELOW, db);
    } else if (Number.isFinite(this.reference)) {
      this.reference = Math.max(this.reference - SILENT_FALL * dt, SILENCE_DB + GONE_BELOW);
    }
    if (target >= this.value) {
      this.value = target;
      this.lowFor = 0;
    } else {
      this.lowFor += dt;
      if (this.lowFor > hold) this.value = target;
    }
    return this.value;
  }

  reset(): void {
    this.value = 0;
    this.reference = Number.NEGATIVE_INFINITY;
    this.lowFor = 0;
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
