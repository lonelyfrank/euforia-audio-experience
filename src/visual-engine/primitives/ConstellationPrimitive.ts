import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, LineSegments, ShaderMaterial, type Object3D } from 'three';
import type { PaletteColors } from '../../types/visualizer';
import type { Primitive, WorldFrame } from '../Primitive';
import type { SolidPrimitive } from './SolidPrimitive';

/*
 * Connections between the pieces of a population of solids (Fractured Expanse): what holds them in one picture without
 * holding them physically. A piece is a connected component of a body's intact links (the structural engine's own
 * reading, SolidState.component); its node is the centre of the elements it has as they are shown this frame.
 *
 *   kin          pieces that were one body: drawn in the colour of what is hot, as long as they are apart — the
 *                history of a fracture, until the engine joins them again
 *   neighbours   pieces of different bodies within `reach`: lit by the highs (the material's spark) and fainter with
 *                distance; a quiet world shows almost none of them
 *
 * Nothing is decided here: every line is a function of where the pieces are and of the frame's material. One draw
 * call; buffers allocated once at their largest; a frame rewrites the part in use.
 */

/** Nodes looked at, at most (pieces of two elements or more), and lines drawn. */
export const MAX_NODES = 32;
export const MAX_LINES = 128;
/** Light of a kin line, and of a neighbour at full spark, before distance. */
const KIN = 0.5;
const NEIGHBOUR = 0.9;
const ATTRIBUTES = ['position', 'aLine'] as const;

const vertexShader = /* glsl */ `
// x: light, y: palette blend, z: heat
attribute vec3 aLine;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
varying vec3 vColor;
void main() {
  vColor = mix(mix(uColorA, uColorB, aLine.y), uColorC, aLine.z) * aLine.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

export class ConstellationPrimitive implements Primitive {
  readonly object: Object3D;
  readonly elements = MAX_LINES;
  readonly vertices = MAX_LINES * 2;
  readonly debug = { nodes: 0, kin: 0, neighbours: 0 };
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private readonly position = new Float32Array(MAX_LINES * 6);
  private readonly look = new Float32Array(MAX_LINES * 6);
  /** Per node: its centre, the body it belongs to, how many elements it has. Per element: the node it adds to. */
  private readonly node = new Float32Array(MAX_NODES * 3);
  private readonly nodeBody = new Int32Array(MAX_NODES);
  private readonly nodeSize = new Int32Array(MAX_NODES);
  private readonly slotOf: Int32Array;

  /** `reach`: how far apart two pieces of different bodies may be and still be joined (units). */
  constructor(private readonly bodies: SolidPrimitive, private readonly reach: number) {
    this.slotOf = new Int32Array(bodies.system.state.capacity);
    const dynamic = (array: Float32Array): BufferAttribute => new BufferAttribute(array, 3).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', dynamic(this.position));
    this.geometry.setAttribute('aLine', dynamic(this.look));
    this.geometry.setDrawRange(0, 0);
    this.material = new ShaderMaterial({
      vertexShader, fragmentShader, transparent: true, depthWrite: false, blending: AdditiveBlending,
      uniforms: { uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorC: { value: new Color() } },
    });
    const lines = new LineSegments(this.geometry, this.material);
    lines.frustumCulled = false;
    this.object = lines;
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    const u = this.material.uniforms;
    (u.uColorA.value as Color).copy(primary); (u.uColorB.value as Color).copy(secondary); (u.uColorC.value as Color).copy(highlight);
  }

  update(frame: Readonly<WorldFrame>, presence: number): void {
    const system = this.bodies.system, m = system.state, s = system.solids!.state, shown = this.bodies.shown, look = frame.look;
    // The pieces: every element adds to the node of its component (its root, the lowest-numbered element of it).
    let nodes = 0;
    const node = this.node, size = this.nodeSize, slotOf = this.slotOf;
    for (let i = 0; i < m.count; i++) {
      const root = s.component[i];
      if (root < 0) { slotOf[i] = -1; continue; }
      if (root === i) {
        if (nodes >= MAX_NODES) { slotOf[i] = -1; continue; }
        slotOf[i] = nodes; node[nodes * 3] = node[nodes * 3 + 1] = node[nodes * 3 + 2] = 0; size[nodes] = 0; this.nodeBody[nodes] = m.body[i]; nodes++;
      } else slotOf[i] = slotOf[root];
      const n = slotOf[i];
      if (n < 0) continue;
      node[n * 3] += shown[i * 3]; node[n * 3 + 1] += shown[i * 3 + 1]; node[n * 3 + 2] += shown[i * 3 + 2]; size[n]++;
    }
    for (let n = 0; n < nodes; n++) { const k = 1 / Math.max(1, size[n]); node[n * 3] *= k; node[n * 3 + 1] *= k; node[n * 3 + 2] *= k; }

    const reach = this.reach, spark = presence * (0.25 * look.emissive + look.spark), memory = presence * Math.max(look.emissive, look.ember);
    let lines = 0, kin = 0, neighbours = 0;
    for (let a = 0; a < nodes && lines < MAX_LINES; a++) {
      if (size[a] < 2) continue;
      for (let b = a + 1; b < nodes && lines < MAX_LINES; b++) {
        if (size[b] < 2) continue;
        const dx = node[b * 3] - node[a * 3], dy = node[b * 3 + 1] - node[a * 3 + 1], dz = node[b * 3 + 2] - node[a * 3 + 2], d = Math.hypot(dx, dy, dz);
        const same = this.nodeBody[a] === this.nodeBody[b];
        const near = 1 - d / (same ? 2 * reach : reach), value = (same ? KIN * memory : NEIGHBOUR * spark) * near * near;
        if (near <= 0 || value < 0.002) continue;
        const at = lines * 6;
        this.position[at] = node[a * 3]; this.position[at + 1] = node[a * 3 + 1]; this.position[at + 2] = node[a * 3 + 2];
        this.position[at + 3] = node[b * 3]; this.position[at + 4] = node[b * 3 + 1]; this.position[at + 5] = node[b * 3 + 2];
        const blend = (this.nodeBody[a] + this.nodeBody[b]) % 2 ? 0.75 : 0.25, heat = same ? 1 : 0.2 * look.spark;
        this.look[at] = this.look[at + 3] = value; this.look[at + 1] = this.look[at + 4] = blend; this.look[at + 2] = this.look[at + 5] = heat;
        lines++;
        if (same) kin++; else neighbours++;
      }
    }
    this.geometry.setDrawRange(0, lines * 2);
    for (const name of ATTRIBUTES) {
      const attribute = this.geometry.attributes[name] as BufferAttribute;
      attribute.clearUpdateRanges();
      if (lines > 0) { attribute.addUpdateRange(0, lines * 6); attribute.needsUpdate = true; }
    }
    const d = this.debug;
    d.nodes = nodes; d.kin = kin; d.neighbours = neighbours;
  }

  reset(): void {
    // Nothing of its own: the lines are where the pieces are.
  }

  dispose(): void {
    this.geometry.dispose(); this.material.dispose();
  }
}
