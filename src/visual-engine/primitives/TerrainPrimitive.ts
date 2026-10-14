import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, LineSegments, Mesh, ShaderMaterial, Vector4, type Object3D } from 'three';
import type { PaletteColors, QualityProfile } from '../../types/visualizer';
import type { Primitive, PrimitiveContext, WorldFrame } from '../Primitive';
import { BEHIND, packTerrain, TERRAIN_VALUES, terrainLawGlsl } from './terrainLaw';
import { TerrainMotion, type TerrainParams } from './terrainMotion';

/*
 * The ground of Generative Terrain: one lattice of low-poly facets, drawn
 * twice from the same vertices (dark facets that hide what lies behind a
 * ridge, and the wire of their edges, which carries the light). Its height is
 * the terrain law (terrainLaw.ts), its motion the terrain's reading of the
 * world (terrainMotion.ts); nothing is created, moved or released while it
 * plays: travelling slides the mesh over the lattice, and the vertices are the
 * same from the first frame to the last. Two draw calls, no texture, no pass.
 *
 * The viewer flies low along the valley: the ground is laid out from the
 * camera (which the world keeps at its origin), pitched so the horizon sits
 * above the middle of the picture, and banks a little into the world's turn.
 */

/** Light of the ground with nothing sounding: the landscape is there, still and dim. */
const REST_LIGHT = 0.16;
/** How much the facets show of their own tilt, at most. */
const FACET = 0.11;
/** Share of the mesh's depth over which the far end fades into the dark. */
const HORIZON = 0.25;
/** Share of the mesh's half width over which its sides fade out. */
const EDGE = 0.15;

/** Columns and rows at a quality: fewer cells, larger ones, the same extent of ground. */
export function terrainQuality(p: TerrainParams, quality: QualityProfile): TerrainParams {
  const scale = Math.sqrt(Math.min(1, Math.max(0.25, quality.density)));
  const columns = Math.max(32, 2 * Math.round(p.columns * scale / 2)), rows = Math.max(64, Math.round(p.rows * scale));
  return { ...p, columns, rows, cell: p.cell * Math.max(p.columns / columns, p.rows / rows) };
}

const vertexShader = /* glsl */ `
${terrainLawGlsl}
// x: light of the lines at rest and with the world's light, y: of the wave fronts, z: of a release front, w: of the diagonals
uniform vec4 uLight;
// x: sparks, y: fog per unit, z: depth of the mesh (units), w: presence
uniform vec4 uAir;
// Half the width of the mesh (units)
uniform float uSpan;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
varying vec3 vColor;
varying vec3 vLocal;
varying float vFog;

void main() {
  float i = position.x, k = position.z, diagonal = position.y;
  float d = terrainDepth(k);
  float h = terrainHeight(i, k, d);
  vec3 P = vec3(terrainAcross(i, d), h, -d);
  // What is far fades into the dark, and so do the row and the columns that are just coming in at the edges of the mesh.
  float side = abs(i - T_SHIFT_X) * T_CELL / uSpan;
  vFog = exp(-max(d, 0.0) * uAir.y) * (1.0 - smoothstep(uAir.z * ${(1 - HORIZON).toFixed(2)}, uAir.z, d)) * (1.0 - smoothstep(${(1 - EDGE).toFixed(2)}, 1.0, side)) * uAir.w;
  float rise = clamp(h / max(T_RELIEF, 1e-3), 0.0, 1.0);
  // Highs: single points of the ground light up, each by its own hash, as far as the shimmer reaches.
  float spark = step(1.0 - 0.3 * uAir.x, terrainFine) * uAir.x;
  float lit = uLight.x * mix(1.0, uLight.w, diagonal) * (0.55 + 0.45 * rise) + uLight.y * terrainFront + uLight.z * terrainBand(d);
  vColor = (mix(uColorA, uColorB, rise) * lit + uColorC * (spark + 0.5 * uLight.y * terrainFront)) * vFog;
  vLocal = P;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(P, 1.0);
}
`;

const wireFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

const fillFragment = /* glsl */ `
uniform vec3 uColorA;
// x: how much each facet shows of its own tilt
uniform float uFacet;
varying vec3 vLocal;
varying float vFog;
void main() {
  // One normal per facet, from the facet itself: low-poly by construction.
  vec3 n = normalize(cross(dFdx(vLocal), dFdy(vLocal)));
  float tilt = 1.0 - abs(n.y);
  gl_FragColor = vec4(uColorA * (0.012 + uFacet * tilt) * vFog, 1.0);
}
`;

export class TerrainPrimitive implements Primitive {
  readonly object: Object3D;
  readonly elements: number;
  readonly vertices: number;
  readonly motion: TerrainMotion;
  readonly debug = { speed: 0, row: 0, tension: 0, terrace: 0, aperture: 0, lift: 0, accent: 0, accents: 0, refused: 0, release: 0, fronts: 0, ring: 0, stir: 0 };
  /** Vertices of the lattice, and of the lines drawn over it (the lattice's own, plus two for each diagonal). */
  readonly lattice: number;
  /**
   * The uniforms both of its materials bind (the packed terrain law, the fronts, light, air, span, colours): stable
   * objects, rewritten each frame. What stands on this ground binds the same ones, so it reads the very same law.
   */
  readonly shared: Record<string, { value: unknown }>;
  readonly params: TerrainParams;
  private readonly wire: ShaderMaterial;
  private readonly fill: ShaderMaterial;
  private readonly wireGeometry = new BufferGeometry();
  private readonly fillGeometry = new BufferGeometry();
  private readonly uTerrain = new Float32Array(TERRAIN_VALUES);

  constructor(context: PrimitiveContext, params: TerrainParams) {
    const p = this.params = params, columns = p.columns, rows = p.rows, across = columns + 1, along = rows + 1;
    this.motion = new TerrainMotion(p);
    this.lattice = across * along;
    const diagonals = columns * rows;
    // x: column from the middle, y: 1 on the two ends of a diagonal (they fade as the ground organises), z: row from the viewer.
    const position = new Float32Array((this.lattice + diagonals * 2) * 3);
    for (let k = 0; k < along; k++) for (let i = 0; i < across; i++) position.set([i - columns / 2, 0, k], (k * across + i) * 3);
    const total = this.lattice + diagonals * 2, Index = total > 65535 ? Uint32Array : Uint16Array;
    const lines = new Index((columns * along + rows * across + diagonals) * 2), faces = new Index(diagonals * 6);
    let l = 0, t = 0, extra = this.lattice;
    for (let k = 0; k < along; k++) for (let i = 0; i < columns; i++) { lines[l++] = k * across + i; lines[l++] = k * across + i + 1; }
    for (let k = 0; k < rows; k++) for (let i = 0; i < across; i++) { lines[l++] = k * across + i; lines[l++] = (k + 1) * across + i; }
    for (let k = 0; k < rows; k++) {
      for (let i = 0; i < columns; i++) {
        const a = k * across + i, b = a + 1, c = a + across, d = c + 1;
        // The diagonal alternates, so the facets do not all lean one way.
        const flip = (i + k) % 2 === 1, from = flip ? b : a, to = flip ? c : d;
        position.set([from % across - columns / 2, 1, Math.floor(from / across)], extra * 3); lines[l++] = extra++;
        position.set([to % across - columns / 2, 1, Math.floor(to / across)], extra * 3); lines[l++] = extra++;
        if (flip) { faces[t++] = a; faces[t++] = c; faces[t++] = b; faces[t++] = b; faces[t++] = c; faces[t++] = d; }
        else { faces[t++] = a; faces[t++] = c; faces[t++] = d; faces[t++] = a; faces[t++] = d; faces[t++] = b; }
      }
    }
    // One vertex buffer for both: the wire and the facets are the same ground.
    const attribute = new BufferAttribute(position, 3);
    this.wireGeometry.setAttribute('position', attribute); this.wireGeometry.setIndex(new BufferAttribute(lines, 1));
    this.fillGeometry.setAttribute('position', attribute); this.fillGeometry.setIndex(new BufferAttribute(faces, 1));
    this.elements = lines.length / 2 + faces.length / 3;
    this.vertices = total;

    const shared = this.shared = {
      uTerrain: { value: this.uTerrain }, uWaveA: { value: context.uWaveA }, uWaveB: { value: context.uWaveB },
      uLight: { value: new Vector4() }, uAir: { value: new Vector4(0, p.fog, (rows - BEHIND) * p.cell, 1) }, uSpan: { value: (columns / 2 - 1) * p.cell },
      uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorC: { value: new Color() },
    };
    this.fill = new ShaderMaterial({
      vertexShader, fragmentShader: fillFragment, uniforms: { ...shared, uFacet: { value: 0 } },
      // The facets sit a little behind their own edges, so the wire is never hidden by the ground it outlines.
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.wire = new ShaderMaterial({ vertexShader, fragmentShader: wireFragment, uniforms: shared, transparent: true, depthWrite: false, blending: AdditiveBlending });
    const facets = new Mesh(this.fillGeometry, this.fill), edges = new LineSegments(this.wireGeometry, this.wire);
    facets.frustumCulled = edges.frustumCulled = false;
    const ground = new Group();
    ground.add(facets, edges);
    // Laid out from the viewer: the valley floor below it, pitched so the far ground rises towards the horizon.
    ground.position.y = -p.height;
    const object = new Group();
    object.add(ground);
    object.rotation.x = p.pitch;
    this.object = object;
    packTerrain(this.uTerrain, this.motion.values);
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    const u = this.wire.uniforms;
    (u.uColorA.value as Color).copy(primary); (u.uColorB.value as Color).copy(secondary); (u.uColorC.value as Color).copy(highlight);
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const p = this.params, look = frame.look, motion = this.motion;
    const values = motion.step(frame.dt, frame.view, frame.geometry, frame.timed ? frame.clock?.events : undefined, frame.time);
    packTerrain(this.uTerrain, values);
    this.object.rotation.z = motion.bank;
    // The lines carry the world's light over what the ground shows at rest; fronts and the release show as far as the
    // shared flash guard admitted (the material's `wave`); the diagonals fade as the ground organises into terraces.
    const base = p.exposure * (REST_LIGHT * (0.5 + 0.5 * look.gate) + 0.9 * look.emissive + look.ember);
    (this.wire.uniforms.uLight.value as Vector4).set(base, p.exposure * look.wave, p.exposure * look.wave * 0.8, 1 - 0.85 * values.terrace);
    const air = this.wire.uniforms.uAir.value as Vector4;
    air.x = look.spark; air.w = presence;
    this.fill.uniforms.uFacet.value = FACET * (0.4 + 0.6 * look.relief) * (0.3 + 0.7 * look.fill);
    if (import.meta.env.DEV) {
      const d = this.debug;
      d.speed = motion.speed; d.row = values.row; d.tension = motion.tension; d.terrace = values.terrace; d.aperture = motion.aperture; d.lift = values.lift;
      d.accent = motion.accent; d.accents = motion.accents; d.refused = motion.refused; d.release = values.release; d.fronts = frame.timed ? frame.waves.active(frame.time) : 0;
      d.ring = motion.ring; d.stir = motion.stir;
    }
  }

  /** A new audio session: the followers start over; the ground travelled stays where it is. */
  reset(): void {
    this.motion.reset();
  }

  dispose(): void {
    this.wireGeometry.dispose(); this.fillGeometry.dispose();
    this.wire.dispose(); this.fill.dispose();
  }
}
