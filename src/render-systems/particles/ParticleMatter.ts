import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, Group, LineSegments, Mesh, Points, ShaderMaterial, Vector2, type Texture } from 'three';
import { BOND_REST } from '../fields/fieldLaw';
import { EDGE } from '../forms/formLaw';
import { STRAND, type MatterLayout } from './MatterSeeds';

/**
 * How the matter emits light, each term 0..1 and owned by the caller's
 * mapping. Light comes from the matter itself: there is no separate flash.
 */
export interface MatterEmission {
  /** Base level of every element (the world's illumination). */
  base: number;
  /** Internal glow: the inner layers (resonance). */
  glow: number;
  /** Fine sparks on the high-affinity matter (shimmer). */
  spark: number;
  /** Energy of the outer layers (excitation). */
  surface: number;
  /** How bright the energy left by passing wave fronts shows (already limited by the flash guard). */
  wave: number;
  /** Share of the elements shown, 0..1 (density / dissolution). */
  density: number;
  /** How visible the bonds along the strands are, 0..1 (connectivity). */
  links: number;
  /** How visible the facets between three neighbours of a strand are, 0..1: where strands open, the matter shows as surface. */
  facets: number;
  /** 0 = facets glow evenly (smooth matter) … 1 = each is lit by how it faces the viewer (hard, angular matter). */
  relief: number;
  /**
   * Shares of the matter the two forms claim (forms/formLaw.ts: the wave form, the harmonic network). Claimed matter
   * is gathered on thin structures: each element shows less light, and a network's bonds and facets span long edges.
   */
  waveShare: number;
  harmonicShare: number;
}

export const createEmission = (): MatterEmission => ({
  base: 0, glow: 0, spark: 0, surface: 0, wave: 0, density: 1, links: 0, facets: 0, relief: 0, waveShare: 0, harmonicShare: 0,
});

/** Length (units) up to which a bond still shows in loose matter and across a harmonic network, and where a line starts to thin out. */
const REACH = BOND_REST * 8;
const NETWORK_REACH = 2;
const THIN = BOND_REST * 4;
/** Light of an element gathered on the wave form / the harmonic network, relative to loose matter. */
const WAVE_LIGHT = 0.75;
const NETWORK_LIGHT = 0.3;
/** Facets of a strand (a strip over its elements), and the area (units²) from which a facet spreads its light thinner. */
const FACETS = STRAND - 2;
const FACET_AREA = 0.012;

const common = /* glsl */ `
  uniform sampler2D tPosition;
  uniform sampler2D tVelocity;
  uniform sampler2D tHome;
  uniform sampler2D tTrait;
  uniform int uWidth;
  uniform float uBase;
  uniform float uDensity;
  uniform float uExposure;
  uniform vec3 uColorA;
  uniform vec3 uColorB;

  uniform sampler2D tForm;
  uniform vec2 uShares;

  ivec2 texel(int index) { return ivec2(index % uWidth, index / uWidth); }
  // Which form claims this strand (x: the wave form, y: the harmonic network), as the form law decides it.
  vec2 claim(ivec2 ref) {
    float key = texelFetch(tForm, ref, 0).y;
    return vec2(1.0 - smoothstep(uShares.x - ${EDGE}, uShares.x, key), smoothstep(1.0 - uShares.y, 1.0 - uShares.y + ${EDGE}, key));
  }
  // Matter gathered on a form is dense: each element carries less light.
  float gathered(vec2 claimed) { return (1.0 - ${(1 - WAVE_LIGHT).toFixed(2)} * claimed.x) * (1.0 - ${(1 - NETWORK_LIGHT).toFixed(2)} * claimed.y); }
  // How long a bond or an edge of this strand may be and still show.
  float reachOf(vec2 claimed) { return mix(${REACH.toFixed(3)}, ${NETWORK_REACH}.0, claimed.y); }
  // Newly formed matter fades in; matter about to dissolve fades out.
  float life(float age) { return smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.85, 1.0, age)); }
`;

const pointVertex = /* glsl */ `
  ${common}
  uniform float uGlow;
  uniform float uSpark;
  uniform float uSurface;
  uniform float uWave;
  uniform float uTwinkle;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform vec3 uColorC;
  varying vec3 vColor;

  void main() {
    ivec2 ref = texel(gl_VertexID);
    vec4 pos = texelFetch(tPosition, ref, 0);
    vec4 vel = texelFetch(tVelocity, ref, 0);
    vec4 home = texelFetch(tHome, ref, 0);
    vec4 trait = texelFetch(tTrait, ref, 0);
    float affinity = home.w;
    float layer = length(home.xyz);
    float energy = min(pos.w, 2.0);
    float alive = life(vel.w) * step(trait.z, uDensity);

    // Sparks: a changing subset of the high-affinity matter, only while the shimmer field is excited.
    float flicker = step(0.8, fract(sin(trait.x * 91.7 + floor(uTwinkle) * 12.9898) * 43758.5453));
    float spark = uSpark * affinity * affinity * flicker;
    float wave = uWave * energy;
    // The matter is the light source: base level, inner glow, surface energy, heat of motion.
    float body = uBase * (0.35 + 0.3 * affinity) + uGlow * (1.0 - layer) + uSurface * smoothstep(0.45, 1.0, layer) * 0.6
      + uBase * min(length(vel.xyz) * 0.25, 0.6);
    vColor = mix(mix(uColorA, uColorB, affinity), uColorC, clamp(spark * 2.0 + wave * 0.5, 0.0, 1.0)) * ((body + spark + wave) * alive * uExposure * gathered(claim(ref)));

    vec4 mv = modelViewMatrix * vec4(pos.xyz, 1.0);
    // Low-affinity matter is large and soft, high-affinity matter fine; passing fronts swell it.
    float size = uSize * (0.7 + 0.9 * (1.0 - affinity)) * (1.0 + 0.6 * min(energy, 1.5));
    gl_PointSize = clamp(size * uPixelRatio * (4.0 / max(-mv.z, 0.5)), 1.0, 10.0 * uPixelRatio);
    gl_Position = alive > 0.003 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const pointFragment = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float glow = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vColor * glow * glow, 1.0);
  }
`;

const linkVertex = /* glsl */ `
  ${common}
  uniform float uLinks;
  uniform int uStride;
  varying vec3 vColor;

  void main() {
    // Segment → the two neighbouring elements of a strand it joins.
    int segment = gl_VertexID / 2;
    int end = gl_VertexID % 2;
    int member = segment % ${STRAND - 1};
    int index = (segment / ${STRAND - 1}) * uStride * ${STRAND} + member + end;
    ivec2 ref = texel(index);
    ivec2 other = texel(index + 1 - 2 * end);
    vec4 pos = texelFetch(tPosition, ref, 0);
    vec3 mate = texelFetch(tPosition, other, 0).xyz;
    vec4 home = texelFetch(tHome, ref, 0);
    vec4 trait = texelFetch(tTrait, ref, 0);
    // A bond shows while it holds: it fades as the two elements drift apart, so connectivity is the matter's own.
    // A long bond carries the same light over more length.
    vec2 claimed = claim(ref);
    float len = distance(pos.xyz, mate);
    float reach = reachOf(claimed);
    float held = (1.0 - smoothstep(reach * 0.25, reach, len)) * min(1.0, ${THIN.toFixed(3)} / max(len, 1e-4));
    float alive = life(texelFetch(tVelocity, ref, 0).w) * life(texelFetch(tVelocity, other, 0).w) * step(trait.z, uDensity);
    float amount = uLinks * held * alive * gathered(claimed);
    vColor = mix(uColorA, uColorB, home.w) * ((uBase * 0.6 + 0.25 * min(pos.w, 2.0)) * amount * uExposure);
    gl_Position = amount > 0.003 ? projectionMatrix * modelViewMatrix * vec4(pos.xyz, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const linkFragment = /* glsl */ `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

const facetVertex = /* glsl */ `
  ${common}
  uniform float uFacets;
  uniform float uRelief;
  uniform int uStride;
  varying vec3 vColor;

  void main() {
    // Facet → three consecutive elements of a strand (a strip along it).
    int facet = gl_VertexID / 3;
    int corner = gl_VertexID % 3;
    int first = (facet / ${FACETS}) * uStride * ${STRAND} + facet % ${FACETS};
    ivec2 r0 = texel(first);
    ivec2 r1 = texel(first + 1);
    ivec2 r2 = texel(first + 2);
    vec4 p0 = texelFetch(tPosition, r0, 0);
    vec3 p1 = texelFetch(tPosition, r1, 0).xyz;
    vec3 p2 = texelFetch(tPosition, r2, 0).xyz;
    vec3 e1 = p1 - p0.xyz;
    vec3 e2 = p2 - p0.xyz;
    vec3 n = cross(e1, e2);
    float doubled = length(n);
    float longest = max(length(e1), max(length(e2), distance(p1, p2)));
    // A facet shows while it holds and only once the strand has opened: three elements in a line span nothing.
    // Facets stay small whatever the strand belongs to: a polygon of the network is hatched by its bonds and
    // shows facets only where its sides converge. Filling whole polygons, one per strand, costs many screens of fill.
    vec2 claimed = claim(r0);
    float held = 1.0 - smoothstep(${(REACH * 0.9).toFixed(3)}, ${(REACH * 1.5).toFixed(3)}, longest);
    float open = smoothstep(0.03, 0.15, doubled / max(longest * longest, 1e-8));
    // The same matter spread over a larger facet is thinner.
    float thin = ${FACET_AREA} / (${FACET_AREA} + 0.5 * doubled);
    vec4 home = texelFetch(tHome, r0, 0);
    vec4 trait = texelFetch(tTrait, r0, 0);
    float alive = life(texelFetch(tVelocity, r0, 0).w) * life(texelFetch(tVelocity, r1, 0).w) * life(texelFetch(tVelocity, r2, 0).w) * step(trait.z, uDensity);
    // Facets of gathered matter overlap far more than its points do.
    float dense = gathered(claimed);
    float amount = uFacets * held * open * thin * alive * dense * dense;
    // Lit from the viewer: smooth matter glows evenly, angular matter shows each facet's own tilt.
    float facing = abs(normalize(normalMatrix * (n / max(doubled, 1e-8))).z);
    float light = mix(1.0, 0.12 + 1.3 * facing * facing, uRelief);
    vColor = mix(uColorA, uColorB, home.w) * ((uBase * 0.5 + 0.2 * min(p0.w, 2.0)) * light * amount * uExposure);
    vec3 P = corner == 0 ? p0.xyz : corner == 1 ? p1 : p2;
    // A facet that would add next to nothing is not rasterized at all.
    gl_Position = amount > 0.01 ? projectionMatrix * modelViewMatrix * vec4(P, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

/**
 * Draws a simulated body of matter in the states it can be seen in: every
 * element as a soft additive point, the bonds of some strands as lines, and
 * the facets between three neighbours of a strand as triangles. Which of them
 * shows is the matter's own doing: a bond while two elements stay close, a
 * facet once a strand has opened into a ribbon or a polygon. It owns no motion: the
 * vertex shaders read the simulation's textures by vertex index (WebGL2), so
 * the geometry is only a draw count. Any backend that provides the same four
 * textures (and the strands' form seeds) can be drawn with it.
 */
export class ParticleMatter {
  /** Add to a scene; rotate or scale it freely. */
  readonly object = new Group();
  private readonly points: ShaderMaterial;
  private readonly links: ShaderMaterial | null = null;
  private readonly facets: ShaderMaterial | null = null;
  /** Vertices submitted per frame for points, bonds and facets (most bonds and facets are discarded before rasterization). */
  readonly vertices: number;

  /**
   * `exposure`: light of one element (additive: fewer elements need more each).
   * `linkShare`, `facetShare`: 0 = none drawn … 1 = every strand's bonds / facets.
   */
  constructor(layout: MatterLayout, homes: Texture, traits: Texture, forms: Texture, size: number, exposure: number, linkShare: number, facetShare = 0) {
    const shared = {
      tPosition: { value: null as Texture | null }, tVelocity: { value: null as Texture | null }, tHome: { value: homes }, tTrait: { value: traits },
      tForm: { value: forms }, uShares: { value: new Vector2() },
      uWidth: { value: layout.width }, uBase: { value: 0 }, uDensity: { value: 1 }, uExposure: { value: exposure }, uColorA: { value: new Color() }, uColorB: { value: new Color() },
    };
    this.points = new ShaderMaterial({
      vertexShader: pointVertex, fragmentShader: pointFragment, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending,
      uniforms: {
        ...shared, uGlow: { value: 0 }, uSpark: { value: 0 }, uSurface: { value: 0 }, uWave: { value: 0 }, uTwinkle: { value: 0 },
        uSize: { value: size }, uPixelRatio: { value: 1 }, uColorC: { value: new Color() },
      },
    });
    this.object.add(drawable(new Points(counted(layout.count), this.points)));
    const strands = layout.count / STRAND;
    const stride = linkShare > 0 ? Math.max(1, Math.round(1 / linkShare)) : 0;
    if (stride > 0) {
      this.links = new ShaderMaterial({
        vertexShader: linkVertex, fragmentShader: linkFragment, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending,
        uniforms: { ...shared, uLinks: { value: 0 }, uStride: { value: stride } },
      });
      this.object.add(drawable(new LineSegments(counted(Math.floor(strands / stride) * (STRAND - 1) * 2), this.links)));
    }
    const facetStride = facetShare > 0 ? Math.max(1, Math.round(1 / facetShare)) : 0;
    if (facetStride > 0) {
      this.facets = new ShaderMaterial({
        vertexShader: facetVertex, fragmentShader: linkFragment, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, side: DoubleSide,
        uniforms: { ...shared, uFacets: { value: 0 }, uRelief: { value: 0 }, uStride: { value: facetStride } },
      });
      this.object.add(drawable(new Mesh(counted(Math.floor(strands / facetStride) * FACETS * 3), this.facets)));
    }
    let vertices = 0;
    this.object.traverse((child) => { vertices += (child as Partial<Points>).geometry?.getAttribute('position').count ?? 0; });
    this.vertices = vertices;
  }

  /** The simulation's current textures (they swap every step). */
  setState(positions: Texture, velocities: Texture): void {
    this.points.uniforms.tPosition.value = positions;
    this.points.uniforms.tVelocity.value = velocities;
  }

  /** `twinkle`: a clock for the sparks (they only show with `spark` > 0). Must not allocate. */
  setEmission(e: Readonly<MatterEmission>, twinkle: number): void {
    const u = this.points.uniforms;
    // Shared uniform objects: the links and the facets see base, density, shares and state too.
    u.uBase.value = e.base; u.uDensity.value = e.density;
    (u.uShares.value as Vector2).set(e.waveShare, e.harmonicShare);
    u.uGlow.value = e.glow; u.uSpark.value = e.spark; u.uSurface.value = e.surface; u.uWave.value = e.wave; u.uTwinkle.value = twinkle;
    if (this.links) this.links.uniforms.uLinks.value = e.links;
    if (this.facets) {
      this.facets.uniforms.uFacets.value = e.facets; this.facets.uniforms.uRelief.value = e.relief;
    }
  }

  setPalette(a: Color, b: Color, c: Color): void {
    const u = this.points.uniforms;
    (u.uColorA.value as Color).copy(a); (u.uColorB.value as Color).copy(b); (u.uColorC.value as Color).copy(c);
  }

  /** Size of an element (device-independent pixels at the rest distance): heavy matter is large and soft. */
  setSize(size: number): void {
    this.points.uniforms.uSize.value = size;
  }

  /** Point sizes are in device pixels. */
  setPixelRatio(ratio: number): void {
    this.points.uniforms.uPixelRatio.value = ratio;
  }

  dispose(): void {
    this.object.traverse((child) => (child as Partial<Points>).geometry?.dispose());
    this.points.dispose();
    this.links?.dispose();
    this.facets?.dispose();
    this.object.clear();
  }
}

/** A geometry that only sets how many vertices are drawn (positions come from the simulation). */
function counted(vertices: number): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices * 3), 3));
  return geometry;
}

function drawable<T extends Points | LineSegments | Mesh>(object: T): T {
  object.frustumCulled = false;
  return object;
}
