import type { AudioEvent, EventCursor, EventStream } from '../../experience/EventStream';

/** Fronts alive at once (the size of the shader's wave uniforms). */
export const MAX_WAVES = 8;
/** An event older than this (s) when first seen starts no wave: it has already passed (a scene mounted mid-session). */
const MAX_AGE = 4;
/** Events closer than this (s) are one front (an attack is reported as an onset and as an impact). */
const SAME = 0.06;
/** Below this a front moves nothing visible and frees its slot. */
const FLOOR = 0.01;

/**
 * Dated wave fronts in space. Each front is born from a discrete event of the
 * experience stream (impact, strong onset, drop) at the event's audio time and
 * is described by that time alone: its radius and amplitude at any instant are
 * functions of `now − start`, so it starts on the event, propagates and decays
 * identically at any frame rate, and a late-arriving event is simply shown at
 * its true age. No detection happens here: the stream is the only source.
 * Bounded (MAX_WAVES), allocation-free after construction.
 */
export class WaveField {
  /** Per front: origin xyz (visual units). */
  readonly origin = new Float32Array(MAX_WAVES * 3);
  /** Audio time of the event (s); -Infinity when the slot is free. */
  readonly start = new Float64Array(MAX_WAVES).fill(-Infinity);
  /** Amplitude at birth, propagation speed (units/s), front width (units), decay (1/s). */
  readonly strength = new Float32Array(MAX_WAVES);
  readonly speed = new Float32Array(MAX_WAVES);
  readonly width = new Float32Array(MAX_WAVES);
  readonly decay = new Float32Array(MAX_WAVES);
  /** Band character 0 (low) … 1 (high), or -1 for a broadband front that moves all matter alike. */
  readonly band = new Float32Array(MAX_WAVES).fill(-1);
  private readonly cursor: EventCursor = { time: -Infinity, seq: 0 };
  private now = -Infinity;
  private lateral = 0;
  private scale = 1;
  private readonly visit = (e: AudioEvent): void => this.onEvent(e);

  /**
   * Starts the fronts of the events heard by `now` (capture clock). `lateral`
   * (−1 … 1) is where the world's forces come from; `scale` is how much the
   * scene takes transients.
   */
  update(now: number, events: EventStream | undefined, lateral = 0, scale = 1): void {
    // A clock that went back is another session: its fronts are not this one's.
    if (now < this.now - 1) this.reset();
    this.now = now;
    this.lateral = lateral;
    this.scale = scale;
    if (events) {
      if (this.cursor.epoch !== undefined && this.cursor.epoch !== events.epoch) this.clear();
      events.forEachHeard(this.cursor, now, this.visit);
    }
    for (let i = 0; i < MAX_WAVES; i++) if (this.start[i] > -Infinity && this.amplitude(i, now) <= 0) this.start[i] = -Infinity;
  }

  /** Seconds since front `i` started (negative or Infinity: not there). */
  age(i: number, now: number): number {
    return now - this.start[i];
  }

  /** Amplitude of front `i` at `now`: 0 before its time and once it has faded. */
  amplitude(i: number, now: number): number {
    const age = now - this.start[i];
    if (!(age >= 0) || age === Infinity) return 0;
    const a = this.strength[i] * Math.exp(-this.decay[i] * age);
    return a > FLOOR ? a : 0;
  }

  /** Fronts still travelling at `now`. */
  active(now: number): number {
    let n = 0;
    for (let i = 0; i < MAX_WAVES; i++) if (this.amplitude(i, now) > 0) n++;
    return n;
  }

  /** Adds a front (the weakest one makes room). Public for hosts that own other dated events. */
  spawn(time: number, strength: number, band: number, speed: number, width: number, decay: number, x = 0, y = 0, z = 0): void {
    if (!(strength > FLOOR) || !Number.isFinite(time)) return;
    let slot = -1;
    // The same attack seen twice: keep the stronger description.
    for (let i = 0; i < MAX_WAVES; i++) if (Math.abs(this.start[i] - time) < SAME) slot = i;
    if (slot >= 0 && strength <= this.strength[slot]) return;
    if (slot < 0) {
      let weakest = Infinity;
      for (let i = 0; i < MAX_WAVES; i++) {
        const a = this.amplitude(i, this.now);
        if (a < weakest) { weakest = a; slot = i; }
      }
    }
    this.start[slot] = time; this.strength[slot] = Math.min(strength, 2);
    this.band[slot] = band; this.speed[slot] = speed; this.width[slot] = width; this.decay[slot] = decay;
    this.origin[slot * 3] = x; this.origin[slot * 3 + 1] = y; this.origin[slot * 3 + 2] = z;
  }

  reset(): void {
    this.clear();
    this.cursor.time = -Infinity; this.cursor.seq = 0; this.cursor.epoch = undefined;
    this.now = -Infinity;
  }

  private clear(): void {
    this.start.fill(-Infinity);
    this.strength.fill(0);
  }

  private onEvent(e: AudioEvent): void {
    if (this.now - e.audioTime > MAX_AGE) return;
    const x = this.lateral * 0.6;
    if (e.type === 'drop') {
      // A real release: one broad, slow, long front from the centre of the world, as strong as what was released.
      this.spawn(e.audioTime, 0.2 + 1.2 * e.strength, -1, 1.1, 0.45, 0.7, x, 0, 0);
      return;
    }
    if (e.type !== 'impact' && e.type !== 'onset') return;
    // An impact counts by how much it matters for the form; a bare onset only when it is strong.
    const strength = e.type === 'impact'
      ? e.strength * (0.5 + 0.5 * e.structuralWeight) * e.confidence * this.scale
      : e.strength > 0.55 ? 0.45 * e.strength * e.confidence * this.scale : 0;
    if (strength < 0.12) return;
    const band = e.band < 0 ? -1 : e.band / 7;
    const pitch = Math.max(0, band);
    // Low fronts are broad and slow, high ones thin and fast. The origin wanders with the event's own time
    // (not its arrival order), so it is the same for any batching.
    const h = Math.floor(e.audioTime * 997);
    const k = h % 5 - 2, m = h % 3 - 1;
    this.spawn(e.audioTime, strength, band, 1.6 + 0.8 * pitch, 0.22 - 0.1 * pitch, 1.4, x + k * 0.06, m * 0.2, k * 0.1);
  }
}
