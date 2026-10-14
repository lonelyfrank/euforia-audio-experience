import { describe, expect, it, vi } from 'vitest';
import { Color, type WebGLRenderer } from 'three';
import { QUALITY_PROFILES } from '../../renderer/quality';
import { SOLIDS_SLOT } from '../../visual-engine/primitives/solidSlot';
import type { RecipeVisualizer } from '../../visual-engine/RecipeVisualizer';
import { LABS } from '../../diagnostics/workspace/Experiment';
import { findVisualizer } from '../../visualizers/registry';
import { EMERGENCE_SLOT } from '../../visualizers/terrain/recipe';
import type { EmergencePrimitive } from '../../visual-engine/primitives/EmergencePrimitive';
import { createParticleSolids, ParticleSolidsExperiment, populationOf, TerrainEmergenceExperiment } from './emergence';

function world(id = 'matter-field', visual?: Record<string, unknown>) {
  const definition = findVisualizer(id)!, scene = definition.create(visual ? { ...definition.preset, visual: { ...definition.preset.visual, ...visual } } : definition.preset) as RecipeVisualizer<unknown>;
  scene.init({ renderer: { getPixelRatio: () => 1, extensions: { has: () => true }, getRenderTarget: () => null, setRenderTarget: vi.fn(), render: vi.fn() } as unknown as WebGLRenderer, quality: QUALITY_PROFILES.low, width: 320, height: 240, addPass: () => undefined });
  scene.setPalette([new Color('purple'), new Color('cyan'), new Color('white')]);
  return scene.world;
}
const ids = (w: ReturnType<typeof world>): string[] => w.mounted.map((m) => m.slot.id);

describe('the Emergence laboratory, without its DOM: solids among the particles', () => {
  it('is one of the laboratories of the experiment', () => {
    expect(LABS.emergence).toBe('Emergence');
  });

  it('mounts its population in the world in view, again when the settings or the layer change, and gives the world back as it was', () => {
    const lab = new ParticleSolidsExperiment(), w = world(), before = ids(w);
    const first = lab.apply(w)!;
    expect(ids(w)).toEqual([...before, SOLIDS_SLOT]);
    expect(first.system.solids!.state.bodies).toBe(3);
    // Nothing changed: the same bodies go on.
    expect(lab.apply(w)).toBe(first);
    lab.settings.bodies = 1; lab.settings.start = 'solid';
    const second = lab.apply(w)!;
    expect(second).not.toBe(first); expect(second.system.solids!.state.bodies).toBe(1);
    expect(ids(w).filter((id) => id === SOLIDS_SLOT)).toHaveLength(1);
    // Off: the scene as the product has it.
    lab.settings.enabled = false;
    expect(lab.apply(w)).toBeNull(); expect(ids(w)).toEqual(before);
    lab.settings.enabled = true;
    lab.apply(w);
    // Another layer (the scene rebuilt, another quality): the old world is given back, the new one takes the population.
    const other = world();
    lab.apply(other);
    expect(ids(w)).toEqual(before); expect(ids(other)).toContain(SOLIDS_SLOT);
    lab.apply(null);
    expect(ids(other)).not.toContain(SOLIDS_SLOT);
    lab.detach(); lab.detach();
  });

  it('works in any Particles recipe, not only Matter Field', () => {
    for (const id of ['vector-field', 'spectral-shell', 'resonant-field']) {
      const lab = new ParticleSolidsExperiment(), w = world(id);
      expect(lab.apply(w), id).not.toBeNull();
      lab.detach();
      expect(ids(w), id).not.toContain(SOLIDS_SLOT);
    }
  });

  it('synthetic events take the session\'s path: a release is offered to the gate, a prediction never is', () => {
    const lab = new ParticleSolidsExperiment(), w = world();
    expect(lab.offer('release', 1)).toBe(false);
    const solid = lab.apply(w)!;
    lab.offer('prediction', 1); lab.offer('accent', 1);
    expect(solid.cuesTaken).toEqual({ releases: 0, accents: 0 });
    lab.offer('release', 1);
    expect(solid.cuesTaken).toEqual({ releases: 1, accents: 0 });
    lab.settings.fracture = 'accent';
    lab.apply(w)!.cue({ seq: 1, kind: 'accent', status: 'observed', time: 1, expected: 0, strength: 0.9, confidence: 1, ref: 0 });
    expect(lab.primitive!.cuesTaken.accents).toBe(1);
    expect(populationOf({ ...createParticleSolids(), bodies: 9 }).bodies).toHaveLength(3);
    lab.detach();
  });
});

describe('the Emergence laboratory, without its DOM: structures out of the ground', () => {
  it('starts from the field in view, changes it in place, and gives back exactly what was there', () => {
    const lab = new TerrainEmergenceExperiment(), w = world('terrain'), field = () => (w.primitive(EMERGENCE_SLOT) as EmergencePrimitive).field;
    const original = { ...field().params }, first = w.primitive(EMERGENCE_SLOT);
    lab.apply(w);
    expect(lab.settings).toMatchObject({ ...original, enabled: true }); expect(lab.changes).toBe(0);
    lab.settings!.capacity = 8; lab.settings!.modes = 'extrude'; lab.settings!.response = 0;
    lab.apply(w);
    expect(field().params).toMatchObject({ capacity: 8, modes: 'extrude', response: 0 }); expect(lab.changes).toBe(3);
    expect(w.primitive(EMERGENCE_SLOT)).toBe(first);
    // Off: the ground alone; on again, a new field with the lab's settings.
    lab.settings!.enabled = false; lab.apply(w);
    expect(ids(w)).toEqual(['ground']);
    lab.settings!.enabled = true; lab.apply(w);
    expect(ids(w)).toEqual(['ground', EMERGENCE_SLOT]); expect(field().params.capacity).toBe(8);
    lab.detach();
    expect(ids(w)).toEqual(['ground', EMERGENCE_SLOT]); expect(field().params).toEqual(original);
    lab.detach();
  });

  it('a terrain that had no emergence gets none back; synthetic cues take the field\'s own path', () => {
    const w = world('terrain', { emergence: { enabled: false } }), lab = new TerrainEmergenceExperiment();
    expect(ids(w)).toEqual(['ground']);
    const p = lab.apply(w)!;
    expect(ids(w)).toEqual(['ground', EMERGENCE_SLOT]);
    lab.offer('prediction', 1); lab.offer('withdraw', 1.5); lab.offer('release', 2); lab.offer('accent', 2.5);
    expect(p.field.stats).toMatchObject({ prepares: 1, withdraws: 1, releases: 1, bursts: 1 });
    lab.reset();
    expect(p.field.stats.releases).toBe(0);
    lab.detach();
    expect(ids(w)).toEqual(['ground']);
  });
});
