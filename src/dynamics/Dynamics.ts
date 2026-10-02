import { PRESETS, type DynamicsPreset, type DynamicsType } from './presets';

/** Default integration step (s): 240 Hz. */
export const DEFAULT_STEP = 1 / 240;
const MAX_CHANNELS = 64;
const MAX_EVENTS = 512;
/** A clock jump larger than this (s) skips ahead instead of integrating every step. */
const MAX_GAP = 1;

const EVENT_TARGET = 0;
const EVENT_IMPULSE = 1;
const EVENT_SNAP = 2;

/** Read-only view of a channel, for diagnostics (debug overlay). */
export interface ChannelState {
  name: string;
  type: DynamicsType;
  value: number;
  velocity: number;
  target: number;
  /** Springs: natural angular frequency (rad/s) and the damping ratio in effect (1 while snapped). */
  omega: number;
  zeta: number;
}

/**
 * The Dynamics layer between the Director and the renderer: the Director
 * schedules targets, impulses and snaps with timestamps on the audio clock
 * (the capture time heard when a frame is seen, see Timing), and the
 * renderer reads values every frame.
 *
 * - Springs integrate at a fixed step on absolute multiples of the clock
 *   with an exact per-step solution (precomputed transition matrices), and
 *   are read interpolated between steps: the values at a given audio time
 *   are the same at 60, 144 fps or with irregular frames.
 * - Envelopes (flash, hit) are evaluated analytically at the exact time:
 *   an impulse jumps to its peak at its own timestamp, with no step or frame
 *   quantization, so they add no latency.
 * - Events are applied in time order; past ones (reported late) take effect
 *   at once. A snap zeroes spring velocities and holds critical damping for
 *   a while (a section boundary: no trail of the build into the drop).
 *
 * Allocation-free after construction; no DOM, no rendering.
 */
export class Dynamics {
  /** Audio time (s) the values are read at. */
  time = 0;
  /** Audio time of the previous read: a late event starts no earlier (it shows at its peak). */
  private previous = 0;
  private started = false;
  /** Start of the current step (a multiple of `step`). */
  private stepTime = 0;
  private count = 0;

  private readonly names: string[] = [];
  private readonly types: DynamicsType[] = [];
  private readonly isSpring = new Uint8Array(MAX_CHANNELS);
  // Springs: state at stepTime (x, v), state at stepTime + step (nx, nv), target.
  private readonly x = new Float64Array(MAX_CHANNELS);
  private readonly v = new Float64Array(MAX_CHANNELS);
  private readonly nx = new Float64Array(MAX_CHANNELS);
  private readonly nv = new Float64Array(MAX_CHANNELS);
  private readonly target = new Float64Array(MAX_CHANNELS);
  private readonly omega = new Float64Array(MAX_CHANNELS);
  private readonly zeta = new Float64Array(MAX_CHANNELS);
  /** Per-step transition matrices (4 per channel): the preset's and the critically damped one. */
  private readonly matrix = new Float64Array(MAX_CHANNELS * 4);
  private readonly critical = new Float64Array(MAX_CHANNELS * 4);
  private readonly snapUntil = new Float64Array(MAX_CHANNELS);
  // Envelopes: level at `ref`, decay time constant.
  private readonly level = new Float64Array(MAX_CHANNELS);
  private readonly ref = new Float64Array(MAX_CHANNELS);
  private readonly decay = new Float64Array(MAX_CHANNELS);

  // Event queue, kept sorted by time.
  private readonly eventTime = new Float64Array(MAX_EVENTS);
  private readonly eventChannel = new Int32Array(MAX_EVENTS);
  private readonly eventKind = new Uint8Array(MAX_EVENTS);
  private readonly eventValue = new Float64Array(MAX_EVENTS);
  private events = 0;
  /** Events dropped because the queue was full (diagnostics). */
  dropped = 0;

  constructor(readonly step = DEFAULT_STEP) {}

  /** Declares a fixture parameter; returns its channel id. `initial` is its resting value. */
  channel(name: string, type: DynamicsType, initial = 0): number {
    if (this.count >= MAX_CHANNELS) throw new Error('Too many dynamics channels');
    const id = this.count++;
    const preset: DynamicsPreset = PRESETS[type];
    this.names[id] = name;
    this.types[id] = type;
    if (preset.kind === 'spring') {
      this.isSpring[id] = 1;
      const omega = 2 * Math.PI * preset.frequency;
      this.omega[id] = omega;
      this.zeta[id] = preset.damping;
      springMatrix(omega, preset.damping, this.step, this.matrix, id * 4);
      springMatrix(omega, 1, this.step, this.critical, id * 4);
      this.x[id] = this.nx[id] = this.target[id] = initial;
    } else {
      this.decay[id] = preset.decay;
      this.level[id] = initial;
    }
    return id;
  }

  /** Moves a spring's target at audio time `at` (default: now). */
  setTarget(channel: number, value: number, at = this.time): void {
    this.schedule(at, channel, EVENT_TARGET, value);
  }

  /** An impulse at `at`: an envelope jumps to `amount` (if higher); a spring gets a velocity kick. */
  impulse(channel: number, amount: number, at = this.time): void {
    this.schedule(at, channel, EVENT_IMPULSE, amount);
  }

  /** Snap at `at`: every spring stops (velocity 0) and stays critically damped for `duration` s; envelopes clear. */
  snap(at: number, duration: number): void {
    this.schedule(at, -1, EVENT_SNAP, duration);
  }

  /** Advances to audio time `t` (never backwards). */
  advance(t: number): void {
    if (!this.started) {
      this.started = true;
      this.stepTime = Math.floor(t / this.step) * this.step;
      this.time = t;
      this.computeNext();
    }
    // The clock started over (a new source): start over too.
    if (t < this.time - MAX_GAP) this.restart();
    if (!this.started) {
      this.started = true;
      this.stepTime = Math.floor(t / this.step) * this.step;
      this.time = t;
      this.computeNext();
    }
    if (t <= this.time) return;
    this.previous = this.time;
    if (t - this.time > MAX_GAP) this.skipTo(t);
    const h = this.step;
    // Envelope events take effect at their exact time; spring events at the step boundary on or after it.
    while (this.stepTime + h <= t) {
      this.stepTime += h;
      for (let c = 0; c < this.count; c++) {
        if (!this.isSpring[c]) continue;
        this.x[c] = this.nx[c];
        this.v[c] = this.nv[c];
      }
      this.applyEvents(this.stepTime, true);
      this.computeNext();
    }
    this.time = t;
    this.applyEvents(t, false);
  }

  /** Forgets time, events and motion; springs rest at their targets. */
  restart(): void {
    this.started = false;
    this.events = 0;
    this.time = this.previous = 0;
    for (let c = 0; c < this.count; c++) {
      this.v[c] = this.nv[c] = 0;
      this.x[c] = this.nx[c] = this.target[c];
      this.level[c] = 0;
      this.ref[c] = 0;
      this.snapUntil[c] = 0;
    }
  }

  /** Value at the current audio time. */
  value(channel: number): number {
    if (this.isSpring[channel]) {
      const a = (this.time - this.stepTime) / this.step;
      return this.x[channel] + (this.nx[channel] - this.x[channel]) * a;
    }
    return this.envelope(channel, this.time);
  }

  get channelCount(): number {
    return this.count;
  }

  /** Diagnostics for one channel (allocates: debug use only). */
  inspect(channel: number): ChannelState {
    const spring = this.isSpring[channel] === 1;
    const snapped = spring && this.time < this.snapUntil[channel];
    return {
      name: this.names[channel],
      type: this.types[channel],
      value: this.value(channel),
      velocity: spring ? this.v[channel] : 0,
      target: spring ? this.target[channel] : 0,
      omega: spring ? this.omega[channel] : 0,
      zeta: spring ? (snapped ? 1 : this.zeta[channel]) : 0,
    };
  }

  private envelope(c: number, t: number): number {
    const dt = t - this.ref[c];
    return dt <= 0 ? this.level[c] : this.level[c] * Math.exp(-dt / this.decay[c]);
  }

  /** The state one step ahead of the current step start, for every spring (exact solution). */
  private computeNext(): void {
    for (let c = 0; c < this.count; c++) {
      if (!this.isSpring[c]) continue;
      const m = this.stepTime < this.snapUntil[c] ? this.critical : this.matrix;
      const i = c * 4;
      const e = this.x[c] - this.target[c];
      const v = this.v[c];
      this.nx[c] = this.target[c] + m[i] * e + m[i + 1] * v;
      this.nv[c] = m[i + 2] * e + m[i + 3] * v;
    }
  }

  /**
   * Applies the queued events due by `t`. At a step boundary (`boundary`)
   * all due events apply; between boundaries only envelope events do (springs
   * wait for the next boundary so every frame rate sees the same steps).
   */
  private applyEvents(t: number, boundary: boolean): void {
    let kept = 0;
    let changedSprings = false;
    for (let i = 0; i < this.events; i++) {
      const time = this.eventTime[i];
      const c = this.eventChannel[i];
      const kind = this.eventKind[i];
      const springEvent = kind === EVENT_SNAP || (c >= 0 && this.isSpring[c] === 1);
      if (time <= t && (boundary || !springEvent)) {
        this.apply(kind, c, this.eventValue[i], time);
        if (springEvent) changedSprings = true;
      } else {
        this.eventTime[kept] = time;
        this.eventChannel[kept] = c;
        this.eventKind[kept] = kind;
        this.eventValue[kept] = this.eventValue[i];
        kept++;
      }
    }
    this.events = kept;
    if (changedSprings && !boundary) this.computeNext();
  }

  private apply(kind: number, c: number, value: number, time: number): void {
    if (kind === EVENT_SNAP) {
      for (let k = 0; k < this.count; k++) {
        if (this.isSpring[k]) {
          this.v[k] = 0;
          this.snapUntil[k] = this.stepTime + value;
        } else {
          this.level[k] = 0;
        }
      }
      return;
    }
    if (this.isSpring[c]) {
      if (kind === EVENT_TARGET) this.target[c] = value;
      // A kick: about `value` of displacement at its peak.
      else this.v[c] += value * this.omega[c];
      return;
    }
    if (kind === EVENT_IMPULSE) {
      // Instant attack at the event's own time, or at the last read if it arrived late (shown at its peak):
      // the peak, not a sum.
      const at = Math.max(time, this.previous, this.ref[c]);
      const current = this.envelope(c, at);
      this.level[c] = Math.max(current, value);
      this.ref[c] = at;
    }
  }

  private schedule(at: number, channel: number, kind: number, value: number): void {
    if (this.events >= MAX_EVENTS) {
      this.dropped++;
      return;
    }
    // Insert sorted (events arrive mostly in order: scan from the end).
    let i = this.events;
    while (i > 0 && this.eventTime[i - 1] > at) {
      this.eventTime[i] = this.eventTime[i - 1];
      this.eventChannel[i] = this.eventChannel[i - 1];
      this.eventKind[i] = this.eventKind[i - 1];
      this.eventValue[i] = this.eventValue[i - 1];
      i--;
    }
    this.eventTime[i] = at;
    this.eventChannel[i] = channel;
    this.eventKind[i] = kind;
    this.eventValue[i] = value;
    this.events++;
  }

  /** A long gap (a stall, a source change): springs settle at their targets, time jumps. */
  private skipTo(t: number): void {
    for (let c = 0; c < this.count; c++) {
      if (!this.isSpring[c]) continue;
      this.x[c] = this.nx[c] = this.target[c];
      this.v[c] = this.nv[c] = 0;
    }
    this.stepTime = Math.floor(t / this.step) * this.step - this.step;
    this.applyEvents(this.stepTime, true);
    this.computeNext();
  }
}

/**
 * Exact transition matrix over one step `h` of the damped oscillator
 * e'' = -ω² e - 2ζω e' (e = displacement from the target): writes
 * [e→e, v→e, e→v, v→v] at `out[at..at+4]`.
 */
export function springMatrix(omega: number, zeta: number, h: number, out: Float64Array, at = 0): void {
  if (Math.abs(zeta - 1) < 1e-6) {
    const k = Math.exp(-omega * h);
    out[at] = k * (1 + omega * h);
    out[at + 1] = k * h;
    out[at + 2] = -k * omega * omega * h;
    out[at + 3] = k * (1 - omega * h);
  } else if (zeta < 1) {
    const a = zeta * omega;
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const k = Math.exp(-a * h);
    const c = Math.cos(wd * h);
    const s = Math.sin(wd * h);
    out[at] = k * (c + (a / wd) * s);
    out[at + 1] = (k * s) / wd;
    out[at + 2] = (-k * omega * omega * s) / wd;
    out[at + 3] = k * (c - (a / wd) * s);
  } else {
    const root = Math.sqrt(zeta * zeta - 1);
    const r1 = -omega * (zeta - root);
    const r2 = -omega * (zeta + root);
    const e1 = Math.exp(r1 * h);
    const e2 = Math.exp(r2 * h);
    const d = r1 - r2;
    out[at] = (r1 * e2 - r2 * e1) / d;
    out[at + 1] = (e1 - e2) / d;
    out[at + 2] = (r1 * r2 * (e2 - e1)) / d;
    out[at + 3] = (r1 * e1 - r2 * e2) / d;
  }
}
