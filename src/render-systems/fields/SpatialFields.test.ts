import { describe, expect, it } from 'vitest';
import { createIntents, createSnapshot, INTENT, type IntentKind } from '../../experience/types';
import { newFrame } from '../../audio/features/decode';
import { createWorld, type WorldState } from '../../world/WorldState';
import { WorldView } from '../../world/WorldView';
import { createMaterial, deriveMaterial, MATERIAL_KEYS } from '../materials/VisualMaterial';
import type { SoundMorphology } from '../../morphology/SoundMorphology';
import { createFields, deriveFields, type SpatialFields } from './SpatialFields';

const NEUTRAL = { motion: 1, expansion: 1, turbulence: 1 };

/** The fields a hand-set world asks for (optionally with the musical terms of a snapshot and one intent). */
function fieldsOf(set: (w: WorldState) => void, intent?: IntentKind, music?: { complexity?: number; harmonicity?: number; flow?: number }) {
  const world = createWorld();
  set(world);
  const view = new WorldView();
  view.update(world, NEUTRAL);
  const snapshot = createSnapshot(newFrame());
  snapshot.acoustic.presence = 1;
  snapshot.acoustic.harmonicity = music?.harmonicity ?? 0.5;
  snapshot.state.complexity = music?.complexity ?? 0.5;
  snapshot.state.flow = music?.flow ?? 0;
  const intents = createIntents();
  if (intent) { intents[INTENT[intent]].strength = 1; intents[INTENT[intent]].confidence = 1; }
  const material = deriveMaterial(createMaterial(), view, snapshot);
  return { fields: deriveFields(createFields(), view, material, intents), material };
}

const rest = () => fieldsOf(() => {}).fields;

describe('world → spatial fields', () => {
  it('each body and field of the world drives its own spatial field', () => {
    const r = rest();
    expect(fieldsOf((w) => { w.radius = 0.6; }).fields.radius).toBeGreaterThan(r.radius + 0.2);
    expect(fieldsOf((w) => { w.radius = -0.4; }).fields.radius).toBeLessThan(r.radius - 0.1);
    expect(fieldsOf((w) => { w.spin = 1.5; }).fields.vortex).toBeGreaterThan(0.5);
    expect(fieldsOf((w) => { w.spin = -1.5; }).fields.vortex).toBeLessThan(-0.5);
    expect(fieldsOf((w) => { w.spin = 1.5; }).fields.flatten).toBeGreaterThan(0.5);
    expect(fieldsOf((w) => { w.speed = 3; }).fields.advection).toBeGreaterThan(0.4);
    expect(fieldsOf((w) => { w.bias = -0.8; }).fields.lateral).toBeLessThan(-0.3);
    expect(fieldsOf((w) => { w.turbulence = 0.9; }).fields.turbulence).toBeGreaterThan(0.7);
    expect(fieldsOf((w) => { w.shimmer = 0.8; }).fields.shimmer).toBeGreaterThan(0.3);
    expect(fieldsOf((w) => { w.radialVelocity = 2; }).fields.surge).toBeGreaterThan(0.8);
    // A world at rest asks for no flow at all: nothing moves on its own.
    for (const key of ['surge', 'vortex', 'advection', 'drift', 'turbulence', 'shimmer', 'lifetimeRate', 'phaseRate'] as const) expect(r[key]).toBe(0);
  });

  it('potential gathers and compresses; a release arrives as outward flow, not as a position', () => {
    const r = rest();
    const charged = fieldsOf((w) => { w.potential = 0.9; }).fields;
    expect(charged.radius).toBeLessThan(r.radius - 0.15);
    expect(charged.gather).toBeGreaterThan(0.8);
    expect(charged.stiffness).toBeGreaterThan(r.stiffness);
    // Stored potential holds dispersion back.
    const loose = fieldsOf((w) => { w.turbulence = 0.8; }).fields.turbulence;
    expect(fieldsOf((w) => { w.turbulence = 0.8; w.potential = 0.9; }).fields.turbulence).toBeLessThan(loose * 0.7);
    const released = fieldsOf((w) => { w.radialVelocity = 1.6; w.speed = 2; }).fields;
    expect(released.surge).toBeGreaterThan(0.5);
    expect(released.radius).toBe(r.radius);
  });

  it('coherence and turbulence are different things: one binds and orders, the other scatters', () => {
    const coherent = fieldsOf((w) => { w.coherence = 1; w.turbulence = 0; }, undefined, { harmonicity: 0.9 });
    const turbulent = fieldsOf((w) => { w.coherence = 0.2; w.turbulence = 0.9; }, undefined, { harmonicity: 0.9, complexity: 0.9 });
    expect(coherent.fields.cohesion).toBeGreaterThan(turbulent.fields.cohesion * 3);
    expect(coherent.fields.bond).toBeGreaterThan(turbulent.fields.bond * 3);
    expect(turbulent.fields.clumping).toBeGreaterThan(coherent.fields.clumping + 3);
    expect(turbulent.fields.lifetimeRate).toBeGreaterThan(0.03);
    expect(coherent.fields.lifetimeRate).toBe(0);
    expect(coherent.material.symmetry).toBeGreaterThan(0.8);
    expect(turbulent.material.fragmentation).toBeGreaterThan(0.8);
    // Turbulence held together by coherence does not fragment: the same disorder, another material.
    expect(fieldsOf((w) => { w.coherence = 1; w.turbulence = 0.9; }, undefined, { complexity: 0.9 }).material.fragmentation).toBe(0);
  });

  it('intents are force components, weighted by confidence', () => {
    const base = fieldsOf((w) => { w.spin = 1; w.speed = 2; w.turbulence = 0.3; w.coherence = 0.8; });
    const withIntent = (kind: IntentKind) => fieldsOf((w) => { w.spin = 1; w.speed = 2; w.turbulence = 0.3; w.coherence = 0.8; }, kind).fields;
    const b = base.fields;
    expect(withIntent('expand').radius).toBeGreaterThan(b.radius);
    expect(withIntent('contract').radius).toBeLessThan(b.radius);
    expect(withIntent('rotate').vortex).toBeGreaterThan(b.vortex);
    expect(withIntent('accelerate').advection).toBeGreaterThan(b.advection);
    expect(withIntent('decelerate').drag).toBeGreaterThan(b.drag + 1);
    expect(withIntent('fragment').bond).toBeLessThan(b.bond);
    expect(withIntent('fragment').turbulence).toBeGreaterThan(b.turbulence);
    expect(withIntent('cohere').cohesion).toBeGreaterThan(b.cohesion);
    expect(withIntent('suspend').drag).toBeGreaterThan(b.drag + 1);
    expect(withIntent('suspend').vortex).toBeLessThan(b.vortex);
    expect(withIntent('dissolve').lifetimeRate).toBeGreaterThan(b.lifetimeRate + 0.3);
    // A doubtful intent moves the fields less.
    const world = createWorld();
    const view = new WorldView();
    view.update(world, NEUTRAL);
    const intents = createIntents();
    intents[INTENT.expand].strength = 1; intents[INTENT.expand].confidence = 0.2;
    const doubtful = deriveFields(createFields(), view, createMaterial(), intents).radius;
    expect(doubtful).toBeGreaterThan(rest().radius);
    expect(doubtful).toBeLessThan(withIntent('expand').radius);
  });

  it('stays finite and bounded for any world, including a corrupt one', () => {
    const bounds = (f: SpatialFields) => {
      for (const [key, value] of Object.entries(f)) expect(Number.isFinite(value), key).toBe(true);
      expect(f.radius).toBeGreaterThanOrEqual(0.45); expect(f.radius).toBeLessThanOrEqual(1.7);
      expect(f.drag).toBeGreaterThanOrEqual(0.9); expect(f.drag).toBeLessThanOrEqual(8);
      expect(f.stiffness).toBeLessThanOrEqual(29); expect(Math.abs(f.vortex)).toBeLessThanOrEqual(2.4);
      expect(f.turbulence).toBeLessThanOrEqual(1.2); expect(f.flatten).toBeLessThanOrEqual(0.9); expect(f.cohesion).toBeLessThanOrEqual(14);
    };
    for (const extreme of [1e9, -1e9, NaN, Infinity]) {
      bounds(fieldsOf((w) => {
        w.radius = w.radialVelocity = w.spin = w.speed = w.bias = w.biasVelocity = extreme;
        w.turbulence = w.coherence = w.potential = w.shimmer = w.excitation = w.openness = extreme; w.angle = w.travel = extreme;
      }, 'fragment').fields);
    }
  });

  it('is a function of the world as seen, not of how often it is looked at', () => {
    // The same world sampled at 30 and at 144 frames per second gives the same fields at the same time.
    const at = (fps: number): SpatialFields => {
      const world = createWorld(), view = new WorldView(), material = createMaterial(), fields = createFields();
      world.spin = 1.2; world.speed = 2;
      view.update(world, NEUTRAL);
      for (let frame = 1; frame <= fps * 2; frame++) {
        const t = frame / fps;
        world.time = t; world.angle = 1.2 * t; world.travel = 2 * t;
        world.radius = 0.4 * Math.sin(t); world.turbulence = 0.5 + 0.4 * Math.sin(3 * t);
        view.update(world, NEUTRAL);
        deriveFields(fields, view, deriveMaterial(material, view), undefined);
      }
      return fields;
    };
    const slow = at(30), fast = at(144);
    for (const key of Object.keys(slow) as (keyof SpatialFields)[]) expect(fast[key]).toBeCloseTo(slow[key], 9);
  });
});

describe('sound → visual material', () => {
  /** The material of a sound with the given morphology in a calm, coherent world (or the one `set` makes). */
  function materialOf(morphology: Partial<SoundMorphology>, set: (w: WorldState) => void = () => {}) {
    const world = createWorld();
    set(world);
    const view = new WorldView();
    view.update(world, NEUTRAL);
    const snapshot = createSnapshot(newFrame());
    snapshot.acoustic.presence = 1;
    Object.assign(snapshot.morphology, morphology);
    return deriveMaterial(createMaterial(), view, snapshot);
  }
  // The corners of the morphology space as the real DSP reads the test signals (SoundMorphology.test.ts).
  const SINE = { periodicity: 1, harmonicity: 1, richness: 0, sharpness: 0.14, stability: 1 };
  const SAW = { periodicity: 0.63, harmonicity: 0.76, richness: 0.83, sharpness: 0.27, stability: 0.71 };
  const SQUARE = { periodicity: 0.94, harmonicity: 0.94, richness: 0.55, sharpness: 0.45, stability: 0.87 };
  const CHORD = { periodicity: 0.34, harmonicity: 0.57, richness: 0.84, sharpness: 0.05, stability: 0.84 };
  const NOISE = { periodicity: 0, harmonicity: 0.02, noisiness: 0.98, richness: 0.01, sharpness: 0.81, stability: 0, density: 0.96 };
  const HATS = { periodicity: 0.01, harmonicity: 0.02, noisiness: 0.81, richness: 0.05, sharpness: 0.98, stability: 0.05, transientness: 0.81 };

  it('continuous properties, not a table: each kind of sound gives the matter its own character', () => {
    const [sine, saw, square, chord, noise, hats] = [SINE, SAW, SQUARE, CHORD, NOISE, HATS].map((m) => materialOf(m));
    // One steady cycle makes continuous matter; a chord has no single cycle, noise none at all.
    expect(sine.continuity).toBeGreaterThan(0.9);
    expect(square.continuity).toBeGreaterThan(saw.continuity);
    expect(saw.continuity).toBeGreaterThan(chord.continuity + 0.1);
    expect(noise.continuity).toBe(0);
    // Stacked partials connect the matter; a lone partial has nothing to connect to.
    expect(sine.connectivity).toBe(0);
    for (const rich of [saw, square, chord]) expect(rich.connectivity).toBeGreaterThan(0.6);
    expect(noise.connectivity).toBeLessThan(0.01);
    // Edges come from a bright, stacked spectrum (a square more than a saw bass, a sine none) and from sharp attacks.
    expect(sine.angularity).toBe(0);
    expect(square.angularity).toBeGreaterThan(saw.angularity);
    expect(saw.angularity).toBeGreaterThan(chord.angularity + 0.2);
    expect(hats.angularity).toBeGreaterThan(noise.angularity + 0.1);
    // Noise grinds the matter fine.
    expect(noise.granularity).toBeGreaterThan(sine.granularity + 0.2);
  });

  it('a world that fragments breaks the forms the sound would give, and no sound means formless matter', () => {
    const calm = materialOf(SAW), broken = materialOf(SAW, (w) => { w.turbulence = 1; w.coherence = 0; });
    expect(broken.fragmentation).toBeGreaterThan(0.5);
    expect(broken.continuity).toBeLessThan(calm.continuity * 0.5);
    expect(broken.connectivity).toBeLessThan(calm.connectivity * 0.5);
    const view = new WorldView();
    view.update(createWorld(), NEUTRAL);
    const formless = deriveMaterial(createMaterial(), view);
    expect(formless).toMatchObject({ continuity: 0, angularity: 0, connectivity: 0 });
  });

  it('is bounded and finite whatever the morphology says', () => {
    for (const value of [NaN, Infinity, -Infinity, 1e9, -1e9]) {
      const material = materialOf({ periodicity: value, harmonicity: value, noisiness: value, richness: value, sharpness: value, stability: value, transientness: value },
        (w) => { w.turbulence = value; w.coherence = value; w.potential = value; });
      for (const key of MATERIAL_KEYS) {
        expect(Number.isFinite(material[key]), `${key} with ${value}`).toBe(true);
        expect(material[key]).toBeGreaterThanOrEqual(0); expect(material[key]).toBeLessThanOrEqual(1);
      }
    }
  });
});
