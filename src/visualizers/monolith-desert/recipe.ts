import { Vector3 } from 'three';
import { CameraRig, Glide, Hover, type GlideParams, type HoverParams, type RigLimits } from '../../render-systems/camera/locomotion';
import { EmergencePrimitive } from '../../visual-engine/primitives/EmergencePrimitive';
import type { EmergenceSettings } from '../../visual-engine/primitives/terrainEmergence';
import { PERIOD, terrainAcross, terrainDepth, terrainHeight } from '../../visual-engine/primitives/terrainLaw';
import { TerrainPrimitive, terrainQuality } from '../../visual-engine/primitives/TerrainPrimitive';
import type { TerrainParams } from '../../visual-engine/primitives/terrainMotion';
import type { RecipeBuilder } from '../../visual-engine/RecipeVisualizer';
import { RigCamera } from '../../visual-engine/RigCamera';
import type { PrimitiveSlot } from '../../visual-engine/WorldRecipe';
import { follow } from '../shared/motion';

/** How the observer of the desert moves: glide over the plain, hover when the music is calm; how far ahead it looks at rest (units). */
export interface DesertCamera {
  glide?: Partial<GlideParams>;
  hover?: Partial<HoverParams>;
  limits?: Partial<RigLimits>;
  look?: number;
}

export interface MonolithDesertParams extends TerrainParams {
  /** The monoliths: the terrain's emergence, standing across the plain (placement `plain`). */
  emergence: EmergenceSettings;
  camera?: DesertCamera;
}

export const MONOLITHS_SLOT = 'monoliths';
/** How far ahead the observer looks at rest (units), and how far up a monolith it looks (share of its height). */
const LOOK = 60;
const UP_THE_FACE = 0.55;
/** The eye takes this long to turn to a monolith and to leave it (s). */
const EYE_TAU = 1.2;

/**
 * Monolith Desert: Generative Terrain's ground laid out as a plain, flown over slowly and low, with monoliths that
 * rise out of it (docs/generative-worlds.md). Nothing here is a copy of the terrain: the ground is TerrainPrimitive
 * with the desert's parameters (a valley floor wider than the view, mesas far off at its edges, a slower stride), the
 * monoliths are the terrain's emergence standing across the floor (placement `plain`, tall slabs and pillars, the
 * tallest kept through a breakdown), anchored by the same law on the same uniforms.
 *
 *   ground      the plain and its far mesas: the terrain law, its motion (travel, pressure, terraces, plates, a release front)
 *   monoliths   EmergenceField + EmergencePrimitive: dormant → formation → emergence → active ⇄ resonance → fracture | retreat
 *   observer    Glide (steady height, the plain's depth) + Hover (calm music: almost still, rising and turning to what grows)
 *
 * The observer hovers in proportion to the world's calm, and while it hovers the ground goes by more slowly (the rig's
 * hold is the ground's pace). It turns its eye, as a head turns, to the monolith the field says the place is showing.
 */
export const monolithDesertRecipe: RecipeBuilder<MonolithDesertParams> = (p, quality) => {
  const params = terrainQuality(p, quality), c = p.camera ?? {};
  let ground: TerrainPrimitive | null = null, monoliths: EmergencePrimitive | null = null;
  const look = c.look ?? LOOK;
  // The ground banks itself into the world's turn: the glide does not bank it twice.
  const rig = new CameraRig([{ profile: new Glide({ bank: 0, ...c.glide }), weight: 1 }, { profile: new Hover(c.hover), weight: 1 }], { tz: -look }, c.limits);
  const seen = { J: 0, R: 0, height: 0, weight: 0 }, point = new Vector3();
  let eye = 0;
  const camera = new RigCamera(rig, (frame, focus) => {
    if (!ground || !monoliths) return;
    const motion = ground.motion, t = motion.values, h = frame.dt > 0 ? Math.min(frame.dt, 0.25) : 0;
    const watched = monoliths.field.focus(params.rows, seen) >= 0;
    eye = follow(eye, watched ? seen.weight : 0, Math.exp(-h / EYE_TAU));
    if (watched) {
      // Where the monolith stands as the ground's shader places it, then as the ground is laid out from the viewer.
      const i = seen.J - t.col, k = ((seen.R - t.row) % PERIOD + PERIOD) % PERIOD, d = terrainDepth(t, k);
      point.set(terrainAcross(t, i, d), terrainHeight(t, i, k) + UP_THE_FACE * seen.height - params.height, -d).applyEuler(ground.object.rotation);
      focus.x = point.x; focus.y = point.y; focus.z = point.z;
    }
    focus.weight = eye;
  }, (r) => { if (ground) ground.motion.pace = r.hold; });
  const slots: PrimitiveSlot[] = [{ id: 'ground', base: true, create: (context) => (ground = new TerrainPrimitive(context, params)) }];
  // After the ground: it reads the ground of this frame, through the same uniforms. Switched off, the desert is the plain alone.
  if (p.emergence.enabled !== false) slots.push({ id: MONOLITHS_SLOT, base: true, create: (context) => (monoliths = new EmergencePrimitive(context, ground!, p.emergence, context.quality)) });
  return { id: 'monolith-desert', seed: p.seed, tilt: 0, memory: 'off', observer: false, camera, slots };
};
