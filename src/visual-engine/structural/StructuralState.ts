import { createIdentity, identityOf, type Population } from './StructuralIdentity';
import { JOINT, MAX_JOINTS, MEMORY_SLOTS, ROLE, ROLE_COUNT, SPAN, type StructuralConfig } from './StructuralTypes';

/*
 * The state of a structural system: fixed-capacity pools laid out as typed
 * arrays, one value per element or per bond. Nothing here is an object per
 * particle and nothing grows: elements are added up to the capacity and are
 * never removed (a fracture frees bonds, not matter); bonds come from a pool
 * with a free list. The layout is what a GPU pass would read: positions and
 * velocities at stride 3, everything else one float per element.
 */

/** Closed loops (polygons) tracked at once, as a share of the capacity (a loop needs at least six elements). */
const LOOPS_PER_ELEMENT = 1 / 6;

export class StructuralState {
  readonly capacity: number;
  readonly bondCapacity: number;
  readonly loopCapacity: number;
  readonly maxSides: number;
  /** Elements in use (0..capacity). */
  count = 0;

  // ---- identity: procedural (StructuralIdentity.identityOf), cached for the elements simulated here ----
  readonly f0: Float32Array;
  readonly q: Float32Array;
  readonly mass: Float32Array;
  readonly damping: Float32Array;
  readonly coupling: Float32Array;
  readonly bondAffinity: Float32Array;
  readonly resistance: Float32Array;
  readonly persistence: Float32Array;
  readonly phase: Float32Array;
  /** Order of the polygon the element tends to (real: 3 … maxSides), and the wire length it prefers (units). */
  readonly sides: Float32Array;
  readonly reach: Float32Array;
  /** The layer of the world's body it was added in, 0 (core) … 1 (rim): where the world's potential holds it. */
  readonly home: Float32Array;
  /** The population it was added with, and the structure it was seeded as part of (−1: none). */
  readonly population: Uint8Array;
  readonly kin: Int32Array;

  // ---- dynamic state ----
  readonly position: Float32Array;
  readonly velocity: Float32Array;
  /** Amplitude of its resonance, its signed swing, and the micro excitation it takes (all from the resonance field). */
  readonly excitation: Float32Array;
  readonly vibration: Float32Array;
  readonly micro: Float32Array;
  /** Kinetic + vibrational energy. */
  readonly energy: Float32Array;
  /** The highest load among its bonds, as a share of what they bear (0 when it has none). */
  readonly stress: Float32Array;
  /** How far it has settled into bonding (≥ 1: it can bond). */
  readonly cohesion: Float32Array;
  /** Local structural order and local activity ("temperature"), 0..1. */
  readonly order: Float32Array;
  readonly temperature: Float32Array;
  /** What a recent fracture left in it: 1 at the break, fading. */
  readonly shock: Float32Array;
  readonly age: Float32Array;
  /** Role weights (ROLE_COUNT per element, summing to one), the dominant one (with hysteresis) and the lifecycle reading. */
  readonly roles: Float32Array;
  readonly role: Uint8Array;
  readonly lifecycle: Uint8Array;
  /** What its neighbourhood looks like (written by the neighbourhood pass). */
  readonly density: Float32Array;
  readonly alignment: Float32Array;
  readonly agreement: Float32Array;

  // ---- topology ----
  /** Its span bond, and its joint bonds (MAX_JOINTS slots); −1: none. */
  readonly span: Int32Array;
  readonly joint: Int32Array;
  readonly joints: Uint8Array;
  /** Sides of the closed loop it is part of (0: none) and that loop's index. */
  readonly loop: Uint8Array;
  readonly loopOf: Int32Array;

  // ---- structural memory: what a broken bond leaves in its two ends ----
  readonly memPartner: Int32Array;
  readonly memRest: Float32Array;
  readonly memStrength: Float32Array;
  /** The role it had when its last bond broke. */
  readonly memRole: Uint8Array;

  // ---- bonds ----
  readonly bondA: Int32Array;
  readonly bondB: Int32Array;
  /** 1: alive. `bondSpan` 1: a wire (it has a length), 0: a joint. */
  readonly bondAlive: Uint8Array;
  readonly bondSpan: Uint8Array;
  /** Rest length now, and the one it settles to (units). */
  readonly bondRest: Float32Array;
  readonly bondTarget: Float32Array;
  readonly bondStiffness: Float32Array;
  readonly bondDamping: Float32Array;
  readonly bondStrength: Float32Array;
  readonly bondAge: Float32Array;
  /** Load now (as a share of what it bears) and accumulated damage 0..1. */
  readonly bondStress: Float32Array;
  readonly bondDamage: Float32Array;
  /** How much of its ends' resonance it carries. */
  readonly bondCoupling: Float32Array;
  /** The first three string modes of a wire: signed displacements as shares of its length. */
  readonly bondModes: Float32Array;
  bonds = 0;
  private readonly freeBonds: Int32Array;
  private freeTop = 0;

  // ---- closed loops (rebuilt by the bookkeeping pass) ----
  loops = 0;
  readonly loopSize: Uint8Array;
  /** One element per corner, in order round the loop. */
  readonly loopCorners: Int32Array;
  readonly loopPlanarity: Float32Array;
  /** How much of a surface the loop is: its elements' surface weight. */
  readonly loopSurface: Float32Array;

  private readonly identity = createIdentity();

  constructor(config: Readonly<StructuralConfig>) {
    const n = this.capacity = Math.max(2, Math.floor(config.capacity));
    const b = this.bondCapacity = n * 2;
    this.maxSides = Math.max(3, Math.floor(config.maxSides));
    const loops = this.loopCapacity = Math.max(1, Math.floor(n * LOOPS_PER_ELEMENT));
    const f = (): Float32Array => new Float32Array(n);
    this.f0 = f(); this.q = f(); this.mass = f().fill(1); this.damping = f(); this.coupling = f(); this.bondAffinity = f(); this.resistance = f();
    this.persistence = f(); this.phase = f(); this.sides = f(); this.reach = f(); this.home = f();
    this.population = new Uint8Array(n); this.kin = new Int32Array(n).fill(-1);
    this.position = new Float32Array(n * 3); this.velocity = new Float32Array(n * 3);
    this.excitation = f(); this.vibration = f(); this.micro = f(); this.energy = f(); this.stress = f(); this.cohesion = f();
    this.order = f(); this.temperature = f(); this.shock = f(); this.age = f();
    this.roles = new Float32Array(n * ROLE_COUNT); this.role = new Uint8Array(n); this.lifecycle = new Uint8Array(n);
    this.density = f(); this.alignment = f().fill(1); this.agreement = f();
    this.span = new Int32Array(n).fill(-1); this.joint = new Int32Array(n * MAX_JOINTS).fill(-1); this.joints = new Uint8Array(n);
    this.loop = new Uint8Array(n); this.loopOf = new Int32Array(n).fill(-1);
    this.memPartner = new Int32Array(n * MEMORY_SLOTS).fill(-1); this.memRest = new Float32Array(n * MEMORY_SLOTS);
    this.memStrength = new Float32Array(n * MEMORY_SLOTS); this.memRole = new Uint8Array(n);
    this.bondA = new Int32Array(b); this.bondB = new Int32Array(b); this.bondAlive = new Uint8Array(b); this.bondSpan = new Uint8Array(b);
    this.bondRest = new Float32Array(b); this.bondTarget = new Float32Array(b); this.bondStiffness = new Float32Array(b);
    this.bondDamping = new Float32Array(b); this.bondStrength = new Float32Array(b); this.bondAge = new Float32Array(b);
    this.bondStress = new Float32Array(b); this.bondDamage = new Float32Array(b); this.bondCoupling = new Float32Array(b);
    this.bondModes = new Float32Array(b * 3);
    this.freeBonds = new Int32Array(b);
    this.loopSize = new Uint8Array(loops); this.loopCorners = new Int32Array(loops * this.maxSides);
    this.loopPlanarity = new Float32Array(loops); this.loopSurface = new Float32Array(loops);
    this.clearBonds();
  }

  /**
   * Adds one element of a population at a point, at rest and free. Returns its
   * index, or −1 when the pool is full (nothing grows past the capacity).
   */
  add(seed: number, population: Readonly<Population>, x: number, y: number, z: number, reach: number): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++, id = identityOf(seed, i, population, this.identity);
    this.f0[i] = id.f0; this.q[i] = id.q; this.mass[i] = id.mass; this.damping[i] = id.damping; this.coupling[i] = id.coupling;
    this.bondAffinity[i] = id.bondAffinity; this.resistance[i] = id.resistance; this.persistence[i] = id.persistence; this.phase[i] = id.seed;
    // Structural matter tends to closed, many-sided figures; matter off the middle to triangles and open chains.
    this.sides[i] = 3 + (this.maxSides - 3) * id.structuralAffinity;
    // A wire is as long as its matter is low: the length of a string follows its pitch.
    this.reach[i] = reach * (1.3 - 0.6 * id.f0);
    this.population[i] = population.id & 0xff; this.kin[i] = -1;
    this.position[i * 3] = x; this.position[i * 3 + 1] = y; this.position[i * 3 + 2] = z;
    // The layer whose loose matter rests at this radius (the inverse of the fields' layer radius at rest).
    this.home[i] = Math.min(1, Math.max(0, (Math.sqrt(x * x + y * y + z * z) - 0.3) / 0.95));
    this.clearElement(i);
    return i;
  }

  /** The other end of bond `b` as seen from element `i`. */
  other(b: number, i: number): number {
    return this.bondA[b] === i ? this.bondB[b] : this.bondA[b];
  }

  /** The element at the other end of `i`'s wire, or −1. */
  spanPartner(i: number): number {
    const b = this.span[i];
    return b < 0 ? -1 : this.other(b, i);
  }

  /** Whether `i` and `j` are joined by a joint. */
  jointed(i: number, j: number): boolean {
    for (let s = 0; s < MAX_JOINTS; s++) {
      const b = this.joint[i * MAX_JOINTS + s];
      if (b >= 0 && this.other(b, i) === j) return true;
    }
    return false;
  }

  /** Takes a bond from the pool and ties it to its ends. Returns its index, or −1 when no bond or no slot is free. */
  bond(a: number, b: number, span: boolean, rest: number, target: number, stiffness: number, damping: number, strength: number, coupling: number): number {
    if (a === b || this.freeTop === 0) return -1;
    let slotA = -1, slotB = -1;
    if (span) { if (this.span[a] >= 0 || this.span[b] >= 0) return -1; }
    else {
      for (let s = MAX_JOINTS - 1; s >= 0; s--) {
        if (this.joint[a * MAX_JOINTS + s] < 0) slotA = s;
        if (this.joint[b * MAX_JOINTS + s] < 0) slotB = s;
      }
      if (slotA < 0 || slotB < 0) return -1;
    }
    const at = this.freeBonds[--this.freeTop];
    this.bondA[at] = a; this.bondB[at] = b; this.bondAlive[at] = 1; this.bondSpan[at] = span ? 1 : 0;
    this.bondRest[at] = rest; this.bondTarget[at] = target; this.bondStiffness[at] = stiffness; this.bondDamping[at] = damping;
    this.bondStrength[at] = strength; this.bondCoupling[at] = coupling;
    this.bondAge[at] = this.bondStress[at] = this.bondDamage[at] = 0;
    this.bondModes[at * 3] = this.bondModes[at * 3 + 1] = this.bondModes[at * 3 + 2] = 0;
    if (span) this.span[a] = this.span[b] = at;
    else {
      this.joint[a * MAX_JOINTS + slotA] = at; this.joint[b * MAX_JOINTS + slotB] = at;
      this.joints[a]++; this.joints[b]++;
    }
    this.bonds++;
    return at;
  }

  /**
   * Breaks bond `at`: the topology changes, the matter does not. Its two ends
   * keep where they are and how they move, and remember each other (the
   * partner, the length that held them, the role they had).
   */
  release(at: number): void {
    if (!this.bondAlive[at]) return;
    const a = this.bondA[at], b = this.bondB[at], span = this.bondSpan[at] === 1, slot = span ? SPAN : JOINT;
    for (let end = 0; end < 2; end++) {
      const i = end === 0 ? a : b, j = end === 0 ? b : a;
      this.memPartner[i * MEMORY_SLOTS + slot] = j;
      this.memRest[i * MEMORY_SLOTS + slot] = this.bondTarget[at];
      this.memStrength[i * MEMORY_SLOTS + slot] = 1;
      this.memRole[i] = this.role[i];
      if (span) this.span[i] = -1;
      else {
        for (let s = 0; s < MAX_JOINTS; s++) if (this.joint[i * MAX_JOINTS + s] === at) this.joint[i * MAX_JOINTS + s] = -1;
        this.joints[i]--;
      }
      this.loop[i] = 0; this.loopOf[i] = -1;
    }
    this.bondAlive[at] = 0;
    this.freeBonds[this.freeTop++] = at;
    this.bonds--;
  }

  /** Empties the pools: no elements, no bonds, no loops. */
  clear(): void {
    this.count = 0; this.loops = 0;
    this.clearBonds();
  }

  private clearBonds(): void {
    this.bondAlive.fill(0); this.bonds = 0;
    // Lowest indices are handed out first, so the same history always uses the same bonds.
    for (let k = 0; k < this.bondCapacity; k++) this.freeBonds[k] = this.bondCapacity - 1 - k;
    this.freeTop = this.bondCapacity;
    this.span.fill(-1); this.joint.fill(-1); this.joints.fill(0);
  }

  private clearElement(i: number): void {
    this.velocity[i * 3] = this.velocity[i * 3 + 1] = this.velocity[i * 3 + 2] = 0;
    this.excitation[i] = this.vibration[i] = this.micro[i] = this.energy[i] = this.stress[i] = this.cohesion[i] = 0;
    this.order[i] = this.temperature[i] = this.shock[i] = this.age[i] = this.density[i] = this.agreement[i] = 0;
    this.alignment[i] = 1;
    for (let r = 0; r < ROLE_COUNT; r++) this.roles[i * ROLE_COUNT + r] = r === ROLE.free ? 1 : 0;
    this.role[i] = ROLE.free; this.lifecycle[i] = 0;
    this.span[i] = -1; this.joints[i] = 0; this.loop[i] = 0; this.loopOf[i] = -1;
    for (let s = 0; s < MAX_JOINTS; s++) this.joint[i * MAX_JOINTS + s] = -1;
    for (let s = 0; s < MEMORY_SLOTS; s++) { this.memPartner[i * MEMORY_SLOTS + s] = -1; this.memRest[i * MEMORY_SLOTS + s] = this.memStrength[i * MEMORY_SLOTS + s] = 0; }
    this.memRole[i] = ROLE.free;
  }
}
