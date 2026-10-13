import type { AudioEvent, EventCursor, EventStream } from '../../experience/EventStream';
import { unit } from '../../experience/types';

/*
 * What a scene that travels through the shared world needs to show its motion:
 * the parts of the tunnel's motion coordinator that are not about a tunnel.
 * Each is the exact answer to an input held through the frame, or the age of a
 * dated event, so what is shown is the same at any frame rate; none has a time
 * of its own, and all come to rest when the world does. No musical state lives
 * here: the world, the events and their significance are read, never decided.
 *
 *   follow          a value going to its target (and arriving)
 *   RateFollower    a speed followed over a time, with the exact distance of the frame
 *   HysteresisGate  something that opens when a drive really passes a bar, and closes later than it opened
 *   AccentGate      the events that stand out, one at a time, as an age
 *
 * The tunnel's coordinator (tunnel/motion.ts) and the terrain's motion
 * (visual-engine/primitives/terrainMotion.ts) are made of these; what each does
 * with them (which parts give way, what an accent opens) is its own.
 */

/** Closer than this to what it follows, a follower is there: what the world has stopped asking for stops, it does not fade for ever. */
export const ARRIVED = 1e-5;
/** `y` towards `x` by what is left of the distance after the frame (`k` = exp(−h / τ)). */
export const follow = (y: number, x: number, k: number): number => (Math.abs(y - x) < ARRIVED ? x : x + (y - x) * k);
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const finite = (x: number): number => (Number.isFinite(x) ? x : 0);

/**
 * A rate (a speed, a turn) followed over a time, and what it covers: a kick gives the world a jump of speed, and what
 * travels with it takes that as a surge. The distance of a frame is the exact integral of the answer, so over time it
 * is the world's own distance, whatever the frame rate.
 */
export class RateFollower {
  /** The rate as it is followed now. */
  rate = 0;

  /** `h` seconds towards `rate`, held through them, over `tau` (s). Returns the distance covered in those seconds. */
  step(h: number, rate: number, tau: number): number {
    const k = Math.exp(-h / tau);
    const distance = rate * h + (this.rate - rate) * tau * (1 - k);
    this.rate = follow(this.rate, rate, k);
    return distance;
  }

  reset(): void {
    this.rate = 0;
  }
}

/**
 * Something that is open or shut, not in between by accident: it opens once its drive passes `openAt`, shuts again
 * only below `closeAt`, and takes its time both ways (`aperture` is a ramp, 0..1). A drive that wavers about a level
 * does not make it flutter.
 */
export class HysteresisGate {
  open = false;
  aperture = 0;

  constructor(readonly openAt: number, readonly closeAt: number, readonly openTime: number, readonly closeTime: number) {}

  /** Starts where the drive already is: something mounted into a strained world is open at once. */
  prime(drive: number): void {
    this.open = drive > this.openAt; this.aperture = this.open ? 1 : 0;
  }

  step(h: number, drive: number): number {
    if (drive > this.openAt) this.open = true; else if (drive < this.closeAt) this.open = false;
    this.aperture = this.open ? Math.min(1, this.aperture + h / this.openTime) : Math.max(0, this.aperture - h / this.closeTime);
    return this.aperture;
  }

  reset(): void {
    this.open = false; this.aperture = 0;
  }
}

/**
 * The events of the session that stand out, one at a time. An impact or a drop is taken only if its `significance`
 * (how far it stands out of the track's own recent ones: the adaptive calibration's rating, never a level) reaches
 * `bar`, and not sooner than `every` seconds after the last one taken; everything else is refused, and counted. What
 * is held of an accent is a function of its age on the audio clock.
 */
export class AccentGate {
  /** Audio time and level (0.5 at the bar … 1) of the accent held. */
  time = -Infinity;
  level = 0;
  /** Events taken and refused (below the bar, or too soon) since the last reset: the tools read them. */
  taken = 0;
  refused = 0;
  private heard = 0;
  private readonly cursor: EventCursor = { time: -Infinity, seq: 0 };

  constructor(readonly bar: number, readonly every: number) {}

  private readonly visit = (event: AudioEvent): void => {
    if (event.type !== 'impact' && event.type !== 'drop') return;
    const weight = unit(finite(event.significance));
    // One accent at a time: an event that does not stand out, or comes too soon after one that did, opens nothing.
    if (weight < this.bar || event.audioTime - this.time < this.every || !Number.isFinite(event.audioTime)) { this.refused++; return; }
    this.time = event.audioTime; this.level = unit(0.5 + 0.5 * (weight - this.bar) / (1 - this.bar)); this.taken++;
  };

  /** Takes the events heard by `now` (the audio time this frame is seen at). */
  read(events: EventStream, now: number): void {
    // Mounted into a running session, it starts from now: what was heard before it was there opens nothing in it.
    if (this.cursor.epoch === undefined) { this.cursor.time = now; this.cursor.seq = events.seq; this.cursor.epoch = events.epoch; }
    this.heard = now;
    events.forEachHeard(this.cursor, now, this.visit);
  }

  /** What is left of the accent held at the time last read: its level, gone over `tau` seconds. 0 before any. */
  value(tau: number): number {
    const age = this.heard - this.time;
    return age >= 0 && Number.isFinite(age) ? this.level * Math.exp(-age / tau) : 0;
  }

  /** Nothing held, nothing counted. Its place in the stream is kept: a reset is not a reason to hear the past again. */
  reset(): void {
    this.time = -Infinity; this.level = 0; this.taken = this.refused = 0;
  }
}
