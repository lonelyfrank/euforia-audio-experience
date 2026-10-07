import type { ExperienceSnapshot } from '../../experience/types';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { WorldView } from '../../world/WorldView';
import type { VisualMaterial } from '../materials/VisualMaterial';
import { FORM, FORM_VALUES } from './formLaw';
import { HarmonicForm } from './HarmonicForm';
import { SignalForm } from './SignalForm';

/** Share of the matter that always stays free: the forms never claim everything. */
export const FREE_SHARE = 0.1;
/** Rows of signal history per second at full world speed, and the trickle that sound alone keeps going. */
const FLOW = 14;
const TRICKLE = 3;
/** A release loosens every form at once and lets it close again over about this long (s). */
const FRACTURE_TAU = 0.9;

/** The states the matter can be pinned to in development; `auto` lets the sound decide. */
export type FormPin = 'auto' | 'particles' | 'wave' | 'harmonic';

/**
 * Development switch (see docs/matter-engine.md): pins the whole body to one
 * state so each experiment can be looked at on its own. Read only in
 * development builds; nothing in the product sets it.
 */
export const matterLab: { form: FormPin } = { form: 'auto' };

/** How the forms are right now. Shares are parts of the matter, 0..1, and never add up to more than 1 − FREE_SHARE. */
export interface FormState {
  /** Share of the matter on the form the waveform generates, and on the harmonic network. */
  wave: number;
  harmonic: number;
  /** Signal form: 0 = the cycle lies open as a line … 1 = closed into a ring. */
  closure: number;
  /** Displacement of the curve by a full-scale signal (units). */
  amplitude: number;
  /** Width of a strand across the history (rows): 0 = filaments along the curve, ≥ 1 = ribbons that merge into a surface. */
  ribbon: number;
  /** Extent of the history along the axis (units). */
  depth: number;
  /** Radius of the low voice's ring when closed (units). */
  ring: number;
  /** Size of the harmonic network relative to the matter's radius. */
  scale: number;
  /** 0..1: how far a release has thrown the forms open. */
  fracture: number;
}

export const createFormState = (): FormState => ({
  wave: 0, harmonic: 0, closure: 0, amplitude: 0.3, ribbon: 0, depth: 1, ring: 0.9, scale: 1, fracture: 0,
});

const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);

/**
 * 0..1: how far the world's last release still holds structures open. A release is the world's own fact (its
 * strength and age): everything that has a structure opens by this much and closes again, together.
 */
export function releaseFracture(view: Readonly<WorldView>): number {
  return unit(1.6 * view.releaseStrength * Math.exp(-Math.max(0, view.releaseAge) / FRACTURE_TAU));
}

/**
 * The forms a body of matter can take, their sources and how much of the
 * matter each claims. Sound → material → form: a continuous material makes the
 * signal's own curve (the more periodic, the more closed; the steadier, the
 * wider its ribbons), a connected one the harmonic network, and what neither
 * claims stays particles. The world then acts on all of it alike: stored
 * potential tightens the forms, a release fractures them, and they close
 * again by themselves. Owns no musical state; allocation-free.
 */
export class MatterForms {
  readonly signal = new SignalForm();
  readonly harmonic = new HarmonicForm();
  readonly state = createFormState();
  private readonly packed = new Float32Array(FORM_VALUES);

  /**
   * `snapshot`: the heard experience (none without a synchronized clock: the
   * forms let go). `radius`: the radius the fields hold the matter at.
   */
  update(dt: number, view: Readonly<WorldView>, material: Readonly<VisualMaterial>, radius: number, frame: AudioFrame, response: VisualResponseFrame, snapshot?: ExperienceSnapshot): void {
    const s = this.state, m = snapshot?.morphology;
    const present = snapshot ? unit(response.presence) : 0;
    // The history flows with the world's travel; sound alone keeps a trickle, silence stops it.
    this.signal.update(dt, snapshot ? FLOW * unit(view.speed) + TRICKLE * present : 0, frame, response);
    this.harmonic.update(dt, snapshot?.acoustic, m ? m.harmonicity : 0);
    // A form needs something to be made of: a voice to draw, nodes to join.
    const voiced = Math.max(this.signal.level[0], this.signal.level[1]);
    let wave = material.continuity * unit(1.5 * voiced), harmonic = material.connectivity * unit(this.harmonic.links / 2);
    const total = wave + harmonic, most = 1 - FREE_SHARE;
    if (total > most) { wave *= most / total; harmonic *= most / total; }
    if (import.meta.env.DEV && matterLab.form !== 'auto') {
      wave = matterLab.form === 'wave' ? most : 0;
      harmonic = matterLab.form === 'harmonic' ? most : 0;
    }
    s.wave = wave; s.harmonic = harmonic;
    s.closure = m ? unit(1.15 * m.periodicity) : 0;
    s.ring = 0.9 * radius;
    // Stored potential draws the curve taut; sharp, angular sound cuts deeper lobes.
    s.amplitude = radius * (0.22 + 0.2 * material.angularity) * (1 - 0.35 * unit(view.tension));
    s.ribbon = 2.4 * material.continuity * (m ? m.stability : 0);
    s.depth = radius * (0.5 + 1.3 * unit(view.openness) + 0.5 * unit(view.speed));
    s.scale = 1;
    // What a release gave the world is still its own fact (strength and age): the forms open by it and close again.
    s.fracture = releaseFracture(view);
    for (const key of KEYS) if (!Number.isFinite(s[key])) s[key] = REST[key];
  }

  /** The packed vector the form law reads (the state, then the signal's ring position, lobes and voice levels). Reused. */
  pack(): Float32Array {
    const out = this.packed, s = this.state, signal = this.signal;
    for (const key of KEYS) out[FORM[key]] = s[key];
    out[FORM.head] = signal.head; out[FORM.frac] = signal.frac;
    out[FORM.lobesLow] = signal.lobes[0]; out[FORM.lobesHigh] = signal.lobes[1];
    out[FORM.levelLow] = signal.level[0]; out[FORM.levelHigh] = signal.level[1];
    return out;
  }

  reset(): void {
    this.signal.reset(); this.harmonic.reset();
    Object.assign(this.state, createFormState());
  }
}

const REST = createFormState();
const KEYS = Object.keys(REST) as (keyof FormState)[];
