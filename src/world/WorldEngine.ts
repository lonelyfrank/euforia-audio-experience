import { springMatrix } from '../dynamics/Dynamics';
import type { AnalysisFrame } from '../audio/features/decode';
import { INTENT, unit, type ExperienceState, type VisualIntent } from '../experience/types';
import {
  BIAS_OMEGA, BIAS_ZETA, COHERENCE_TAU, createWorld, EXCITATION_TAU, ILLUMINATION_FADE, ILLUMINATION_RISE, MAX_BIAS_VELOCITY,
  MAX_RADIAL_VELOCITY, MAX_SPEED, MAX_SPIN, OPENNESS_TAU, POTENTIAL_LEAK, RADIAL_OMEGA, RADIAL_ZETA, SHIMMER_TAU, SPIN_DRAG,
  TRAVEL_DRAG, TURBULENCE_RISE, TURBULENCE_SETTLE, type WorldState,
} from './WorldState';

/*
 * Intent → force → state: the music never writes a position. Every hop the
 * world integrates the forces held since the previous hop (exact solutions:
 * damped springs via the shared spring matrix, linear drag in closed form,
 * first-order fields as exponentials), then receives the hop's impulses and
 * sets the forces for the next interval. Extrapolating a snapshot to the
 * heard time integrates the same held forces, so what a frame shows depends
 * only on the audio and the heard time, never on the frame rate.
 */

/** Spring matrices for one step length, cached (allocation-free when the step repeats). */
export class WorldIntegrator {
  private readonly m = new Float64Array(8);
  private h = -1;

  /** Advances `w` by `h` seconds with its held forces. Impulses are not part of this. */
  integrate(w: WorldState, h: number): void {
    if (!(h > 0)) return;
    const f = w.forces, m = this.m;
    if (h !== this.h) {
      springMatrix(RADIAL_OMEGA, RADIAL_ZETA, h, m, 0);
      springMatrix(BIAS_OMEGA, BIAS_ZETA, h, m, 4);
      this.h = h;
    }
    let dx = w.radius - f.radialRest;
    w.radius = f.radialRest + m[0] * dx + m[1] * w.radialVelocity;
    w.radialVelocity = m[2] * dx + m[3] * w.radialVelocity;
    dx = w.bias - f.biasRest;
    w.bias = f.biasRest + m[4] * dx + m[5] * w.biasVelocity;
    w.biasVelocity = m[6] * dx + m[7] * w.biasVelocity;
    // Linear drag: v' = F − c·v; position integrates in closed form.
    let k = Math.exp(-f.spinDrag * h), terminal = f.torque / f.spinDrag, v0 = w.spin - terminal;
    w.angle += terminal * h + v0 * (1 - k) / f.spinDrag;
    w.spin = terminal + v0 * k;
    k = Math.exp(-f.travelDrag * h); terminal = f.thrust / f.travelDrag; v0 = w.speed - terminal;
    w.travel += terminal * h + v0 * (1 - k) / f.travelDrag;
    w.speed = terminal + v0 * k;
    // Saturating fields: x' = r(1 − x) − x/τ, bounded in [0, 1).
    w.excitation = saturating(w.excitation, f.excitationRate, EXCITATION_TAU, h);
    w.shimmer = saturating(w.shimmer, f.shimmerRate, SHIMMER_TAU, h);
    w.potential = saturating(w.potential, f.charge, POTENTIAL_LEAK, h);
    w.turbulence = relax(w.turbulence, f.turbulenceTarget, f.turbulenceTarget > w.turbulence ? TURBULENCE_RISE : TURBULENCE_SETTLE, h);
    w.coherence = relax(w.coherence, f.coherenceTarget, COHERENCE_TAU, h);
    w.illumination = relax(w.illumination, f.illuminationTarget, f.illuminationTarget > w.illumination ? ILLUMINATION_RISE : ILLUMINATION_FADE, h);
    w.openness = relax(w.openness, f.opennessTarget, OPENNESS_TAU, h);
    w.time += h;
    account(w);
  }
}

/** Kinetic, elastic, stored and wave energy (visual units: each body's natural scale counts as 1). */
export function account(w: WorldState): void {
  const spin = w.spin / MAX_SPIN, speed = w.speed / MAX_SPEED;
  w.kinetic = 0.5 * (w.radialVelocity ** 2 + w.biasVelocity ** 2) + 2 * (spin * spin + speed * speed);
  w.elastic = 0.5 * ((RADIAL_OMEGA * w.radius) ** 2 + (BIAS_OMEGA * w.bias) ** 2);
  w.stored = w.potential;
  w.wave = w.excitation + w.shimmer;
  w.energy = w.kinetic + w.elastic + w.stored + w.wave;
}

/** Owns the world of one audio session. Advanced per analysis hop by ExperienceEngine. */
export class WorldEngine {
  readonly state = createWorld();
  private readonly integrator = new WorldIntegrator();
  private started = false;

  /** Integrates the interval that ends at `time` with the forces held since the previous hop. */
  advance(time: number): void {
    const w = this.state;
    if (this.started && time > w.time) this.integrator.integrate(w, time - w.time);
    w.time = time;
    this.started = true;
  }

  /**
   * An impact (discrete event, its own audio time): momentum to the bodies.
   * `band` −1 broadband, 0..7 low → high; `pan` −1 left … 1 right (0 for mono).
   * Off-centre sound pushes the world sideways and spins it; a centred one only breathes and surges.
   */
  impact(time: number, strength: number, band: number, pan: number): void {
    const w = this.state;
    const low = band < 0 ? 0.6 : band <= 2 ? 1 : 0.35;
    w.radialVelocity = limit(w.radialVelocity + 0.9 * strength * low, MAX_RADIAL_VELOCITY);
    w.speed = limit(w.speed + 0.5 * strength, MAX_SPEED);
    w.spin = limit(w.spin + 0.8 * strength * pan, MAX_SPIN);
    w.biasVelocity = limit(w.biasVelocity + 0.8 * strength * pan, MAX_BIAS_VELOCITY);
    w.excitation += 0.4 * strength * (1 - w.excitation);
    w.impulseTime = time;
    w.impulseStrength = strength;
    account(w);
  }

  /**
   * An actual release (drop): the stored potential turns into motion. Without
   * preparation little is stored and the release is small; a forecast that
   * never came true is never released, it leaks.
   */
  release(time: number, strength: number): void {
    const w = this.state;
    const amount = w.potential * (0.5 + 0.5 * unit(strength));
    w.potential -= amount;
    w.radialVelocity = limit(w.radialVelocity + 1.6 * amount, MAX_RADIAL_VELOCITY);
    w.speed = limit(w.speed + 2 * amount, MAX_SPEED);
    w.spin = limit(w.spin + 0.6 * amount * (w.spin < 0 ? -1 : 1), MAX_SPIN);
    w.excitation += amount * (1 - w.excitation);
    w.releaseTime = time;
    w.releaseStrength = amount;
    account(w);
  }

  /**
   * The hop's continuous inputs: transients excite the wave fields (each
   * transient is a per-hop rise, so its sum is the attack's size, whatever
   * the hop), and the forces for the next interval are set from the acoustic
   * frame, the experience state and the intents (strength × confidence).
   */
  setForces(a: AnalysisFrame, s: ExperienceState, intents: readonly VisualIntent[], presence: number): void {
    const w = this.state, f = w.forces;
    const p = presence;
    let broad = 0, fine = 0;
    for (let b = 0; b < 5; b++) broad += a.bandTransient[b];
    for (let b = 5; b < 8; b++) fine += a.bandTransient[b];
    w.excitation += unit(broad * 0.12 * p) * (1 - w.excitation);
    w.shimmer += unit(fine * 0.25 * p) * (1 - w.shimmer);
    const expand = weight(intents[INTENT.expand]) - weight(intents[INTENT.contract]);
    const suspend = weight(intents[INTENT.suspend]);
    const brake = 1 + 2.5 * weight(intents[INTENT.decelerate]) + 1.2 * suspend;
    // Pressure: sustained bass above its floor holds the world open; stored tension draws it in.
    const bass = (a.bandLevel[0] + a.bandLevel[1]) * 0.5 * p;
    f.radialRest = clamp(0.45 * expand + 0.3 * bass + 0.2 * w.openness - 0.35 * w.potential, -0.6, 0.9);
    // Torque from the music's turning (motion, stereo movement) and the harmonic flow; a lateral sweep spins too.
    f.spinDrag = SPIN_DRAG * brake;
    f.torque = f.spinDrag * (0.6 * weight(intents[INTENT.rotate]) + 0.25 * s.flow * s.motion) + 0.6 * w.biasVelocity * p;
    // Thrust from motion (activity, not loudness); a held state of potential holds the world back.
    f.travelDrag = TRAVEL_DRAG * brake;
    f.thrust = f.travelDrag * 1.6 * s.motion * (1 + 0.6 * weight(intents[INTENT.accelerate])) * (1 - 0.3 * w.potential);
    // Where the sound is: balance, trusted as far as the stereo is; mono stays centred.
    f.biasRest = clamp(a.balance * 1.5, -1, 1) * a.stereoConfidence * p;
    // Sustained resonance keeps the surface ringing; bright, dense textures keep the fine field alive.
    f.excitationRate = 0.6 * s.resonance;
    let high = 0;
    for (let b = 5; b < 8; b++) high += a.bandActivity[b];
    f.shimmerRate = unit(high / 3) * 2 * p;
    // Disorder is independent of loudness: roughness, chaos, complexity without order, phase instability between channels.
    f.turbulenceTarget = unit(unit(0.45 * s.chaos + 0.3 * a.roughness * p + 0.25 * s.complexity * (1 - s.order) +
      0.2 * (1 - a.interChannelCoherence) * a.stereoConfidence * p) +
      0.5 * weight(intents[INTENT.fragment]) + 0.4 * weight(intents[INTENT.dissolve]) - 0.4 * weight(intents[INTENT.cohere]));
    // Coupling from harmonicity, phase coherence and channel correlation; in silence the structure regains it.
    const coupling = unit(0.4 * a.harmonicity + 0.3 * a.phaseCoherence + 0.3 * (0.5 + 0.5 * a.correlation));
    f.coherenceTarget = unit(p * coupling + (1 - p) + 0.3 * weight(intents[INTENT.cohere]) -
      0.4 * weight(intents[INTENT.fragment]) - 0.3 * weight(intents[INTENT.dissolve]));
    // Preparation dims a little: the stored state is released into light later.
    f.illuminationTarget = unit(0.1 + 0.9 * s.energy) * p * (1 - 0.3 * w.potential);
    f.opennessTarget = unit(s.openness + 0.3 * weight(intents[INTENT.reveal]));
    // Prediction charges potential, weighted by its confidence: a doubtful forecast prepares little.
    f.charge = 0.3 * (0.5 * unit(s.likelyBuild) * s.predictionConfidence + 0.7 * s.anticipation * s.anticipationConfidence);
    account(w);
  }

  reset(): void {
    const forces = this.state.forces;
    Object.assign(this.state, createWorld());
    Object.assign(forces, createWorld().forces);
    this.state.forces = forces;
    this.started = false;
  }
}

function saturating(x: number, rate: number, tau: number, h: number): number {
  const k = rate + 1 / tau;
  const steady = rate / k;
  return steady + (x - steady) * Math.exp(-k * h);
}

function relax(x: number, target: number, tau: number, h: number): number {
  return target + (x - target) * Math.exp(-h / tau);
}

/** Soft velocity limit: linear for small values, never above `max`. */
function limit(v: number, max: number): number {
  return max * Math.tanh(v / max);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function weight(intent: VisualIntent): number {
  return intent.strength * intent.confidence;
}
