import type { AnalysisFrame } from '../audio/features/decode';
import { follow, unit } from './types';

const SCALES = [0.15, 2, 10, 45, 180] as const;
const DIMS = 24;
const MOTIFS = 32;
/** Bounded multi-scale memory. No raw audio, spectrum histories or unbounded session log. */
export class TemporalMemory {
  readonly energy = new Float64Array(5);
  readonly complexity = new Float64Array(5);
  readonly tension = new Float64Array(5);
  readonly fingerprints = new Float32Array(MOTIFS * DIMS);
  readonly counts = new Uint32Array(MOTIFS);
  readonly lastSeen = new Float64Array(MOTIFS).fill(-Infinity);
  /** Visual history for the session: scene, palette lead, intensity and transition times. */
  readonly sceneUsage = new Float64Array(7);
  readonly transitionTime = new Float64Array(32).fill(-Infinity);
  readonly transitionScene = new Int8Array(32).fill(-1);
  readonly paletteState = new Uint8Array(32);
  readonly visualIntensity = new Float32Array(32);
  transitions = 0;
  drops = 0;
  climaxes = 0;
  pauses = 0;
  novelty = 0;
  familiarity = 0;
  motif = -1;
  recurrence = 0;
  private readonly fingerprint = new Float64Array(DIMS);
  private readonly previous = new Float64Array(DIMS);
  private initialized = false;
  private soundStart = -1;
  private printReady = false;
  private nextCompare = 0;
  private used = 0;
  private replacement = 0;
  private active = -1;
  private lastVisualTime = 0;
  private lastScene = -1;

  update(f: AnalysisFrame, energy: number, complexity: number, tension: number, dt: number): void {
    if (this.soundStart < 0 && f.presence > 0.5 && !f.silent) this.soundStart = f.time;
    const settled = this.initialized && this.soundStart >= 0 && f.time - this.soundStart > 1.5;
    for (let i = 0; i < 5; i++) {
      this.energy[i] = settled ? follow(this.energy[i], energy, dt, SCALES[i]) : energy;
      this.complexity[i] = settled ? follow(this.complexity[i], complexity, dt, SCALES[i]) : complexity;
      this.tension[i] = settled ? follow(this.tension[i], tension, dt, SCALES[i]) : tension;
    }
    this.initialized = true;
    const v = this.fingerprint;
    let maxBand = -96;
    for (let b = 0; b < 8; b++) maxBand = Math.max(maxBand, f.bandDb[b]);
    for (let b = 0; b < 8; b++) v[b] = follow(v[b], unit(1 + (f.bandDb[b] - maxBand) / 40), dt, 1);
    for (let b = 0; b < 12; b++) v[b + 8] = follow(v[b + 8], f.chroma[b] * f.chromaConfidence, dt, 1);
    v[20] = this.energy[1];
    v[21] = follow(v[21], unit(f.onsetDensity / 8), dt, 1);
    v[22] = follow(v[22], f.entropy, dt, 1);
    v[23] = follow(v[23], f.width * f.stereoConfidence, dt, 1);
    if (f.time < this.nextCompare || f.presence < 0.2 || f.silent) return;
    this.nextCompare = f.time + 0.5;
    let change = 0;
    for (let d = 0; d < DIMS; d++) change += (v[d] - this.previous[d]) ** 2;
    this.novelty = this.printReady ? unit(Math.sqrt(change / DIMS) * 5) : 0;
    this.previous.set(v); this.printReady = true;
    if (f.time < 4) return;
    let best = -1, distance = Infinity;
    for (let m = 0; m < this.used; m++) {
      let sum = 0;
      for (let d = 0; d < DIMS; d++) sum += (v[d] - this.fingerprints[m * DIMS + d]) ** 2;
      const delta = Math.sqrt(sum / DIMS);
      if (delta < distance) { distance = delta; best = m; }
    }
    this.familiarity = best >= 0 ? unit(1 - distance / 0.3) : 0;
    if (best < 0 || distance > 0.18) {
      best = this.used < MOTIFS ? this.used++ : this.replacement++ % MOTIFS;
      for (let d = 0; d < DIMS; d++) this.fingerprints[best * DIMS + d] = v[d];
      this.counts[best] = 1;
      this.lastSeen[best] = f.time;
    } else if (best !== this.active && f.time - this.lastSeen[best] > 8) {
      this.counts[best]++;
    }
    this.lastSeen[best] = f.time;
    this.active = this.motif = best;
    this.recurrence = this.counts[best] - 1;
  }

  recordVisual(time: number, scene: number, hue: number, intensity: number): void {
    const dt = Math.max(0, Math.min(1, time - this.lastVisualTime));
    if (scene >= 0 && scene < this.sceneUsage.length) this.sceneUsage[scene] += dt;
    this.lastVisualTime = time;
    if (scene === this.lastScene) return;
    this.lastScene = scene;
    const i = this.transitions++ % 32;
    this.transitionTime[i] = time; this.transitionScene[i] = scene;
    this.paletteState[i] = hue; this.visualIntensity[i] = intensity;
  }

  reset(): void {
    this.energy.fill(0); this.complexity.fill(0); this.tension.fill(0);
    this.fingerprints.fill(0); this.counts.fill(0); this.lastSeen.fill(-Infinity);
    this.fingerprint.fill(0); this.previous.fill(0); this.sceneUsage.fill(0);
    this.transitionTime.fill(-Infinity); this.transitionScene.fill(-1); this.paletteState.fill(0); this.visualIntensity.fill(0);
    this.initialized = this.printReady = false;
    this.soundStart = -1;
    this.used = this.replacement = this.nextCompare = this.transitions = this.drops = this.climaxes = this.pauses = 0;
    this.motif = this.active = this.lastScene = -1;
    this.novelty = this.familiarity = this.recurrence = this.lastVisualTime = 0;
  }
}
