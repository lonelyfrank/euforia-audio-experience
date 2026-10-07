import { describe, expect, it } from 'vitest';
import { AudioAnalyzer } from '../../audio/analysis/AudioAnalyzer';
import { newFrame, type AnalysisFrame } from '../../audio/features/decode';
import { VisualResponse } from '../../audio/visual-response/VisualResponse';
import { createSnapshot } from '../../experience/types';
import { createWorld } from '../../world/WorldState';
import { WorldView } from '../../world/WorldView';
import { createMaterial } from '../materials/VisualMaterial';
import { STRAND, matterLayout, seedMatter } from '../particles/MatterSeeds';
import { formAnchor } from './formLaw';
import { consonance, HarmonicForm, NODES } from './HarmonicForm';
import { FREE_SHARE, MatterForms, matterLab } from './MatterForms';
import { SIGNAL_ROWS, SIGNAL_SIZE, SignalForm } from './SignalForm';

const NEUTRAL = { motion: 1, expansion: 1, turbulence: 1 };

/** An analysis frame carrying the given partials (Hz, level), loudest first. */
function partials(list: [hz: number, level: number, pan?: number][]): AnalysisFrame {
  const a = newFrame();
  list.forEach(([hz, level, pan = 0], i) => { a.partialHz[i] = hz; a.partialLevel[i] = level; a.partialPan[i] = pan; });
  return a;
}
/** Lets a harmonic form follow `frame` for `seconds` at `fps`. */
function follow(form: HarmonicForm, frame: AnalysisFrame | undefined, seconds: number, fps = 60, trust = 1): HarmonicForm {
  for (let i = 0; i < Math.round(seconds * fps); i++) form.update(1 / fps, frame, trust);
  return form;
}
/** The node following a partial at `hz` (−1 if none). */
function nodeAt(form: HarmonicForm, hz: number): number {
  for (let n = 0; n < NODES; n++) if (form.level[n] > 0.05 && Math.abs(form.pitch[n] - Math.log2(hz / 55)) < 0.03) return n;
  return -1;
}
const HARMONICS: [number, number][] = [1, 2, 3, 4, 5, 6].map((h) => [110 * h, 1 / h]);
const MINOR: [number, number][] = [[440, 1], [523.25, 0.9], [659.25, 0.8]];

describe('harmonic form', () => {
  it('relates partials by their interval: octaves, fifths and thirds belong together, a semitone or a tritone do not', () => {
    for (const ratio of [2, 3 / 2, 4 / 3, 5 / 4, 3, 4, 5]) expect(consonance(Math.log2(ratio)), `${ratio}`).toBeGreaterThan(0.5);
    for (const ratio of [16 / 15, 45 / 32, 1.03, 1.9]) expect(consonance(Math.log2(ratio)), `${ratio}`).toBeLessThan(0.1);
    expect(consonance(Math.log2(2))).toBeGreaterThan(consonance(Math.log2(3 / 2)));
    expect(consonance(Math.log2(3 / 2))).toBeGreaterThan(consonance(Math.log2(6 / 5)));
    // Symmetric, and the same in every octave.
    expect(consonance(-Math.log2(3 / 2))).toBe(consonance(Math.log2(3 / 2)));
    expect(consonance(Math.log2(3))).toBeCloseTo(consonance(Math.log2(3 / 2)), 6);
  });

  it('turns the partials of a harmonic tone into a connected structure, and a chord into its triangle', () => {
    const tone = follow(new HarmonicForm(), partials(HARMONICS), 1);
    expect(tone.active).toBe(6);
    // The fundamental is tied to every harmonic that is strong enough.
    const root = nodeAt(tone, 110);
    for (const hz of [220, 330, 440]) expect(tone.relation(root, nodeAt(tone, hz)), `${hz}`).toBeGreaterThan(0.3);
    expect(tone.links).toBeGreaterThanOrEqual(6);
    const chord = follow(new HarmonicForm(), partials(MINOR), 1);
    expect(chord.active).toBe(3);
    expect(chord.links).toBe(3);
    // Inharmonic partials of the same levels hold together far less.
    const bell = follow(new HarmonicForm(), partials(HARMONICS.map(([, level], i) => [110 * (i + 1) ** 1.17, level])), 1);
    expect(bell.links).toBeLessThan(tone.links - 2);
  });

  it('places a node by its partial: octaves line up, pitch winds outwards and up, the stereo position shifts it', () => {
    const form = follow(new HarmonicForm(), partials([[110, 1], [220, 0.8], [440, 0.7], [165, 0.6], [330, 0.5, 0.9]]), 1);
    const at = (hz: number) => form.position(nodeAt(form, hz));
    const angle = (p: number[]) => Math.atan2(p[1], p[0]);
    const [a, b, c, fifth] = [at(110), at(220), at(440), at(165)];
    // Same pitch class: the same direction from the axis, further out and higher with each octave.
    expect(angle(b)).toBeCloseTo(angle(a), 3);
    expect(angle(c)).toBeCloseTo(angle(a), 3);
    expect(Math.hypot(b[0], b[1])).toBeGreaterThan(Math.hypot(a[0], a[1]) + 0.1);
    expect(c[2]).toBeGreaterThan(b[2] + 0.1); expect(b[2]).toBeGreaterThan(a[2] + 0.1);
    // A fifth sits 0.585 of a turn round.
    expect(((angle(fifth) - angle(a)) / (2 * Math.PI) + 1) % 1).toBeCloseTo(0.585, 2);
    // The partial on the right is shifted to the right of where its pitch alone would put it.
    const centred = follow(new HarmonicForm(), partials([[330, 1]]), 1);
    expect(at(330)[0]).toBeGreaterThan(centred.position(nodeAt(centred, 330))[0] + 0.2);
  });

  it('keeps a partial on its node when the list is reordered, and lets a node glide with its partial', () => {
    const form = follow(new HarmonicForm(), partials([[220, 1], [330, 0.6], [550, 0.4]]), 1);
    const [low, mid, high] = [220, 330, 550].map((hz) => nodeAt(form, hz));
    // The DSP lists partials by level: the same three, louder in another order.
    follow(form, partials([[550, 1], [220, 0.7], [330, 0.5]]), 0.5);
    expect([220, 330, 550].map((hz) => nodeAt(form, hz))).toEqual([low, mid, high]);
    // Vibrato / a slide: the node follows, it is not replaced.
    const before = form.position(mid).slice();
    follow(form, partials([[550, 1], [220, 0.7], [338, 0.5]]), 0.5);
    expect(nodeAt(form, 338)).toBe(mid);
    const moved = Math.hypot(...form.position(mid).map((v, k) => v - before[k]));
    expect(moved).toBeGreaterThan(0.01); expect(moved).toBeLessThan(0.3);
  });

  it('a change of harmony reconfigures the structure: shared notes stay, the others fade and are taken over once gone', () => {
    const form = follow(new HarmonicForm(), partials([[220, 1], [277.18, 0.9], [329.63, 0.8]]), 1);
    const [a, cSharp, e] = [220, 277.18, 329.63].map((hz) => nodeAt(form, hz));
    // A major → A minor: the third moves by a semitone (too far to be the same partial), root and fifth stay.
    const minor = partials([[220, 1], [261.63, 0.9], [329.63, 0.8]]);
    form.update(1 / 60, minor, 1);
    // Just after the change the old third is still there, fading, beside the new one: no cut.
    expect(form.level[cSharp]).toBeGreaterThan(0.5);
    follow(form, minor, 0.2);
    expect(nodeAt(form, 220)).toBe(a); expect(nodeAt(form, 329.63)).toBe(e);
    const c = nodeAt(form, 261.63);
    expect(c).toBeGreaterThanOrEqual(0); expect(c).not.toBe(cSharp);
    expect(form.level[cSharp]).toBeGreaterThan(0.2);
    follow(form, minor, 3);
    expect(form.level[cSharp]).toBeLessThan(0.01);
    expect(form.active).toBe(3);
    // With every node taken, a new partial replaces only a clearly weaker one.
    const full = follow(new HarmonicForm(), partials(Array.from({ length: 8 }, (_, i) => [200 + 97 * i, i === 7 ? 0.2 : 0.9] as [number, number])), 1);
    expect(full.active).toBe(8);
    const weakest = nodeAt(full, 200 + 97 * 7);
    follow(full, partials([...Array.from({ length: 7 }, (_, i) => [200 + 97 * i, 0.9] as [number, number]), [1500, 0.8], [200 + 97 * 7, 0.2]]), 1);
    expect(nodeAt(full, 1500)).toBe(weakest);
  });

  it('trusts partials only as far as the sound is tonal, and lets the structure fade without sound', () => {
    const noise = follow(new HarmonicForm(), partials(HARMONICS), 1, 60, 0);
    expect(noise.active).toBe(0);
    const form = follow(new HarmonicForm(), partials(HARMONICS), 1);
    follow(form, undefined, 0.3);
    // Fading, not gone: a silence between two notes does not tear the structure down at once.
    expect(form.active).toBeGreaterThan(0);
    follow(form, undefined, 4);
    expect(form.active).toBe(0); expect(form.links).toBe(0);
    for (let n = 0; n < NODES; n++) expect(form.level[n]).toBe(0);
  });

  it('follows at the same pace at 30, 60 and 144 frames per second, and survives corrupted partials', () => {
    const run = (fps: number) => {
      const form = follow(new HarmonicForm(), partials(HARMONICS), 0.5, fps);
      return follow(form, partials(MINOR), 0.25, fps);
    };
    const [a, b, c] = [30, 60, 144].map(run);
    for (let i = 0; i < a.data.length; i++) { expect(b.data[i]).toBeCloseTo(a.data[i], 1); expect(c.data[i]).toBeCloseTo(a.data[i], 1); }
    const form = new HarmonicForm(), bad = partials(HARMONICS);
    for (const value of [NaN, Infinity, -1, 0, 1e9]) {
      bad.partialHz.fill(value); bad.partialLevel.fill(value); bad.partialPan.fill(value); bad.partialPhase.fill(value);
      follow(form, bad, 0.2);
      for (const x of form.data) expect(Number.isFinite(x)).toBe(true);
    }
  });

  it('lets absent node numbers stand for present nodes, so three partials hold several times the matter their own numbers would', () => {
    const chord = follow(new HarmonicForm(), partials(MINOR), 1);
    const present = new Set([440, 523.25, 659.25].map((hz) => nodeAt(chord, hz)));
    for (let n = 0; n < NODES; n++) expect(present.has(chord.standsFor[n])).toBe(true);
    for (const node of present) expect(chord.standsFor[node]).toBe(node);
    // Strands seeded on any pair of numbers now find a related pair, unless both stand for the same node.
    const { form, layout } = seedMatter(matterLayout(8000), 5);
    let held = 0, own = 0;
    for (let i = 0; i < layout.count; i += STRAND) {
      const code = form[i * 4 + 2], a = code % NODES, b = Math.floor(code / NODES) % NODES;
      if (chord.data[((1 + a) * NODES + b) * 4] > 0.2) held++;
      if (present.has(a) && present.has(b)) own++;
    }
    const strands = layout.count / STRAND;
    expect(own / strands).toBeLessThan(0.15);
    expect(held / strands).toBeGreaterThan(0.35);
  });
});

/** A response whose voices carry the given cycles (and nothing else). */
function voices(lead: (x: number) => number, leadVoice: number, bassVoice = 0, pitch = 220) {
  const response = new VisualResponse().frame, audio = new AudioAnalyzer().frame;
  for (let i = 0; i < SIGNAL_SIZE; i++) { response.music.leadLine[i] = lead(i / SIGNAL_SIZE); response.music.bassLine[i] = Math.sin(2 * Math.PI * i / SIGNAL_SIZE); }
  response.music.leadVoice = leadVoice; response.music.bassVoice = bassVoice; response.music.leadPitch = pitch; response.music.bassPitch = 55;
  response.audible = 1; response.presence = 1;
  return { response, audio };
}
const saw = (x: number) => 2 * x - 1;
const sine = (x: number) => Math.sin(2 * Math.PI * x);

describe('signal form', () => {
  it('writes the real cycle of each voice into its live row, scaled by how present the voice is', () => {
    const form = new SignalForm(), { response, audio } = voices(saw, 0.8, 0.5);
    form.update(1 / 60, 0, audio, response);
    const lead = (1 * SIGNAL_ROWS + form.head) * SIGNAL_SIZE, bass = form.head * SIGNAL_SIZE;
    for (const i of [0, 31, 64, 127]) {
      expect(form.data[lead + i]).toBeCloseTo(saw(i / SIGNAL_SIZE) * 0.8, 5);
      expect(form.data[bass + i]).toBeCloseTo(sine(i / SIGNAL_SIZE) * 0.5, 5);
    }
    expect([...form.level]).toEqual([0.5, expect.closeTo(0.8, 5)]);
    // An absent voice writes a flat row and holds nothing.
    response.music.bassVoice = 0;
    form.update(1 / 60, 0, audio, response);
    expect(Math.max(...form.data.subarray(bass, bass + SIGNAL_SIZE).map(Math.abs))).toBe(0);
    expect(form.level[0]).toBe(0);
  });

  it('carries the raw waveform when nothing is pitched, without counting it as a voice', () => {
    const form = new SignalForm(), { response, audio } = voices(sine, 0);
    for (let i = 0; i < audio.waveform.length; i++) audio.waveform[i] = i % 16 < 8 ? 0.9 : -0.9;
    form.update(1 / 60, 0, audio, response);
    const lead = (SIGNAL_ROWS + form.head) * SIGNAL_SIZE;
    let energy = 0;
    for (let i = 0; i < SIGNAL_SIZE; i++) energy += Math.abs(form.data[lead + i]);
    expect(energy / SIGNAL_SIZE).toBeGreaterThan(0.2);
    expect(form.level[1]).toBe(0);
    // Inaudible: nothing at all.
    response.audible = 0;
    form.update(1 / 60, 0, audio, response);
    expect(Math.max(...form.data.subarray(lead, lead + SIGNAL_SIZE).map(Math.abs))).toBe(0);
  });

  it('advances its history by the flow it is given, the same at any frame rate, and stands still without flow', () => {
    const run = (fps: number, flow: number) => {
      const form = new SignalForm(), { response, audio } = voices(saw, 1);
      let pushes = 0, head = form.head;
      for (let i = 0; i < fps * 3; i++) {
        form.update(1 / fps, flow, audio, response);
        if (form.head !== head) { pushes += (form.head - head + SIGNAL_ROWS) % SIGNAL_ROWS; head = form.head; }
      }
      return { pushes, form };
    };
    for (const fps of [30, 60, 144]) expect(run(fps, 8).pushes, `${fps}`).toBeGreaterThanOrEqual(23);
    for (const fps of [30, 60, 144]) expect(run(fps, 8).pushes, `${fps}`).toBeLessThanOrEqual(24);
    const still = run(60, 0);
    expect(still.pushes).toBe(0); expect(still.form.frac).toBe(0);
    // A pushed row keeps what was live when it was pushed.
    const { form } = run(60, 8), { response, audio } = voices(sine, 1);
    const old = (SIGNAL_ROWS + (form.head - 3 + SIGNAL_ROWS) % SIGNAL_ROWS) * SIGNAL_SIZE;
    form.update(1 / 60, 0, audio, response);
    expect(form.data[old + 96]).toBeCloseTo(saw(96 / SIGNAL_SIZE), 5);
    expect(form.data[(SIGNAL_ROWS + form.head) * SIGNAL_SIZE + 32]).toBeCloseTo(1, 5);
  });

  it('winds more lobes for a higher voice, gliding, and stays finite on corrupted input', () => {
    const form = new SignalForm(), low = voices(sine, 1, 0, 110), high = voices(sine, 1, 0, 880);
    for (let i = 0; i < 120; i++) form.update(1 / 60, 4, low.audio, low.response);
    const few = form.lobes[1];
    form.update(1 / 60, 4, high.audio, high.response);
    expect(form.lobes[1]).toBeLessThan(few + 0.5);
    for (let i = 0; i < 240; i++) form.update(1 / 60, 4, high.audio, high.response);
    expect(form.lobes[1]).toBeGreaterThan(few + 3);
    for (const value of [NaN, Infinity, -Infinity]) {
      high.response.music.leadLine.fill(value); high.response.music.leadPitch = value; high.response.music.leadVoice = value;
      high.audio.waveform.fill(value);
      form.update(value, value, high.audio, high.response);
      form.update(1 / 60, value, high.audio, high.response);
      for (const x of form.data) expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(form.lobes[1])).toBe(true); expect(Number.isFinite(form.frac)).toBe(true);
    }
  });
});

/** Forms pinned to given shares over a steady saw lead, with their packed vector. */
function formed(set: Partial<MatterForms['state']>, lead = saw, signalFlow = 8) {
  const forms = new MatterForms(), { response, audio } = voices(lead, 1, 1);
  for (let i = 0; i < 60; i++) forms.signal.update(1 / 60, signalFlow, audio, response);
  follow(forms.harmonic, partials(HARMONICS), 1);
  Object.assign(forms.state, { closure: 1, amplitude: 0.3, ribbon: 0, depth: 1, ring: 1, scale: 1, fracture: 0, wave: 0, harmonic: 0 }, set);
  const seeds = seedMatter(matterLayout(4096), 9);
  const anchor = (i: number, lateral = 0, turn = 0, radius = 1) => Array.from(formAnchor(seeds.form, i, forms.pack(), lateral, turn, radius, forms.signal.data, forms.harmonic.data));
  return { forms, seeds, anchor };
}

describe('form law', () => {
  it('claims matter strand by strand: the forms share it, the rest stays free, and the split moves continuously', () => {
    const count = (wave: number, harmonic: number) => {
      const { seeds, anchor } = formed({ wave, harmonic });
      let onWave = 0, onNetwork = 0, free = 0;
      for (let i = 0; i < seeds.layout.count; i += STRAND) {
        const key = seeds.form[i * 4 + 1], hold = anchor(i)[3];
        if (key < wave - 0.04) { onWave++; expect(hold).toBe(1); }
        else if (key > 1 - harmonic + 0.04) onNetwork++;
        else if (key > wave && key < 1 - harmonic) { free++; expect(hold).toBe(0); }
        // A strand is claimed as a whole (a harmonic strand is then held only if its pair is related).
        if (key < wave) expect(anchor(i + STRAND - 1)[3]).toBe(hold);
      }
      const strands = seeds.layout.count / STRAND;
      return { wave: onWave / strands, harmonic: onNetwork / strands, free: free / strands };
    };
    const none = count(0, 0);
    expect(none).toEqual({ wave: 0, harmonic: 0, free: 1 });
    const split = count(0.4, 0.3);
    expect(split.wave).toBeCloseTo(0.36, 1); expect(split.harmonic).toBeCloseTo(0.26, 1); expect(split.free).toBeCloseTo(0.3, 1);
    // A slightly larger share claims a few more strands, never other ones.
    const { seeds, anchor } = formed({ wave: 0.4 }), more = formed({ wave: 0.45 });
    for (let i = 0; i < seeds.layout.count; i += STRAND) expect(more.anchor(i)[3]).toBeGreaterThanOrEqual(anchor(i)[3]);
  });

  it('bends the waveform into geometry: a closed ring displaced by the signal, an open line when it is not periodic', () => {
    const closed = formed({ wave: 1, closure: 1, amplitude: 0.3, ring: 1 });
    const open = formed({ wave: 1, closure: 0, amplitude: 0.3, ring: 1 });
    const flat = formed({ wave: 1, closure: 1, amplitude: 0, ring: 1 });
    let lowRing = 0, highRing = 0, lows = 0, highs = 0, displaced = 0, span = 0, off = 0;
    for (let i = 0; i < closed.seeds.layout.count; i++) {
      const voice = Math.floor(closed.seeds.form[i * 4 + 3]);
      const p = flat.anchor(i), r = Math.hypot(p[0], p[1]);
      if (voice) { highRing += r; highs++; } else { lowRing += r; lows++; }
      const q = closed.anchor(i);
      displaced = Math.max(displaced, Math.abs(Math.hypot(q[0], q[1]) - r));
      const line = open.anchor(i);
      span = Math.max(span, Math.abs(line[0])); off = Math.max(off, Math.abs(line[1]));
      for (const v of [...q, ...line]) expect(Number.isFinite(v)).toBe(true);
    }
    // Without signal the cycle is a circle: one per voice, the high voice inside the low one.
    expect(lowRing / lows).toBeCloseTo(1, 3);
    expect(highRing / highs).toBeCloseTo(0.62, 3);
    // The signal displaces it by up to the amplitude (the newest row; older rows less).
    expect(displaced).toBeGreaterThan(0.2); expect(displaced).toBeLessThanOrEqual(0.3 + 1e-6);
    // Open: a line of half the ring's length, displaced sideways only by the signal.
    expect(span).toBeGreaterThan(1.3); expect(span).toBeLessThan(1.7);
    expect(off).toBeLessThanOrEqual(0.3 + 0.02);
  });

  it('opens a strand into a ribbon across the history as the matter grows continuous, a filament otherwise', () => {
    const area = (ribbon: number) => {
      const { seeds, anchor } = formed({ wave: 1, ribbon, amplitude: 0 });
      let sum = 0, n = 0;
      for (let i = 0; i < seeds.layout.count; i += STRAND) {
        const depth = seeds.form[i * 4 + 3] % 1;
        // Strands at the ends of the history are clipped: look at the middle.
        if (depth < 0.2 || depth > 0.8) continue;
        const [a, b, c] = [anchor(i), anchor(i + 1), anchor(i + 2)];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        sum += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
        n++;
      }
      return sum / n;
    };
    expect(area(0)).toBeLessThan(1e-4);
    expect(area(2)).toBeGreaterThan(area(1) * 1.8);
    expect(area(1)).toBeGreaterThan(1e-3);
  });

  it('the history recedes along the axis and scrolls smoothly: no jump when a row is pushed', () => {
    const { forms, seeds, anchor } = formed({ wave: 1, depth: 2 }, saw, 8);
    let front = -Infinity, back = Infinity;
    for (let i = 0; i < seeds.layout.count; i++) { const z = anchor(i)[2]; front = Math.max(front, z); back = Math.min(back, z); }
    expect(front).toBeCloseTo(1, 1); expect(back).toBeCloseTo(-1, 1);
    // A different cycle arrives; anchors deep in the history must move little from one frame to the next, push or not.
    const { response, audio } = voices(sine, 1, 1);
    const before = new Float64Array(seeds.layout.count * 3);
    let largest = 0, pushes = 0;
    for (let frame = 0; frame < 60; frame++) {
      for (let i = 0; i < seeds.layout.count; i += 7) { const p = anchor(i); before[i * 3] = p[0]; before[i * 3 + 1] = p[1]; before[i * 3 + 2] = p[2]; }
      const head = forms.signal.head;
      forms.signal.update(1 / 60, 8, audio, response);
      if (forms.signal.head !== head) pushes++;
      for (let i = 0; i < seeds.layout.count; i += 7) {
        if (seeds.form[i * 4 + 3] % 1 < 0.15) continue;
        const p = anchor(i);
        largest = Math.max(largest, Math.hypot(p[0] - before[i * 3], p[1] - before[i * 3 + 1], p[2] - before[i * 3 + 2]));
      }
    }
    expect(pushes).toBeGreaterThan(5);
    // The two cycles differ by up to 2 × 0.3 units; a frame moves an anchor by a fraction of that.
    expect(largest).toBeLessThan(0.12);
  });

  it('lays a strand along a related pair as a filament and opens it into a polygon when a third node is related too', () => {
    const { forms, seeds, anchor } = formed({ harmonic: 1 });
    const node = (n: number) => [forms.harmonic.data[n * 4], forms.harmonic.data[n * 4 + 1], forms.harmonic.data[n * 4 + 2]];
    let filaments = 0, polygons = 0, unrelated = 0;
    for (let i = 0; i < seeds.layout.count; i += STRAND) {
      const code = seeds.form[i * 4 + 2], a = code % NODES, b = Math.floor(code / NODES) % NODES, c = Math.floor(code / (NODES * NODES));
      expect(new Set([a, b, c]).size).toBe(3);
      const pair = forms.harmonic.data[((1 + a) * NODES + b) * 4];
      const triple = Math.min(forms.harmonic.data[((1 + a) * NODES + c) * 4], forms.harmonic.data[((1 + b) * NODES + c) * 4]);
      const first = anchor(i), second = anchor(i + 1), last = anchor(i + STRAND - 2);
      if (pair < 0.08) { unrelated++; expect(first[3]).toBe(0); continue; }
      // Strands at the very edge of the share are only partly claimed.
      if (pair < 0.4 || seeds.form[i * 4 + 1] < 0.05) continue;
      expect(first[3]).toBeGreaterThan(0.9);
      // The two sides start on the two nodes.
      const [A, B, C] = [node(a), node(b), node(c)];
      for (let k = 0; k < 3; k++) { expect(first[k]).toBeCloseTo(A[k], 5); expect(second[k]).toBeCloseTo(B[k], 5); }
      // Distance of the strand's far end from the line through the pair: 0 for a filament.
      const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], ap = [last[0] - A[0], last[1] - A[1], last[2] - A[2]];
      const cross = Math.hypot(ab[1] * ap[2] - ab[2] * ap[1], ab[2] * ap[0] - ab[0] * ap[2], ab[0] * ap[1] - ab[1] * ap[0]) / Math.max(Math.hypot(...ab), 1e-9);
      const height = Math.hypot((C[1] - A[1]) * ab[2] - (C[2] - A[2]) * ab[1], (C[2] - A[2]) * ab[0] - (C[0] - A[0]) * ab[2], (C[0] - A[0]) * ab[1] - (C[1] - A[1]) * ab[0]) / Math.max(Math.hypot(...ab), 1e-9);
      if (triple < 0.1) { filaments++; expect(cross).toBeLessThan(1e-5); }
      else if (triple > 0.45 && height > 0.1) { polygons++; expect(cross).toBeGreaterThan(height * 0.5); }
    }
    expect(filaments).toBeGreaterThan(0); expect(polygons).toBeGreaterThan(0); expect(unrelated).toBeGreaterThan(0);
  });

  it('a form follows the fields: it sits at their centre, turns with the world and scales with the matter; a fracture lets go', () => {
    const { seeds, anchor } = formed({ wave: 0.5, harmonic: 0.5 });
    for (let i = 0; i < seeds.layout.count; i += 41) {
      const p = anchor(i), shifted = anchor(i, 0.3), turned = anchor(i, 0, Math.PI / 2);
      if (!(p[3] > 0)) continue;
      expect(shifted[0]).toBeCloseTo(p[0] + 0.3, 6); expect(shifted[1]).toBeCloseTo(p[1], 6);
      expect(turned[0]).toBeCloseTo(-p[1], 6); expect(turned[1]).toBeCloseTo(p[0], 6); expect(turned[2]).toBeCloseTo(p[2], 6);
      const grown = anchor(i, 0, 0, 2);
      // The network scales with the radius it is given; the signal's ring has its own (state.ring).
      if (seeds.form[i * 4 + 1] > 0.5) for (let k = 0; k < 3; k++) expect(grown[k]).toBeCloseTo(2 * p[k], 6);
    }
    const whole = formed({ wave: 1 }), broken = formed({ wave: 1, fracture: 0.7 }), gone = formed({ wave: 1, fracture: 1 });
    expect(broken.anchor(0)[3]).toBeCloseTo(whole.anchor(0)[3] * 0.3, 6);
    expect(gone.anchor(0)[3]).toBe(0);
  });
});

describe('matter forms', () => {
  /** The forms after `seconds` of a given material and morphology. */
  function derive(set: { continuity?: number; connectivity?: number; angularity?: number; periodicity?: number; stability?: number; harmonicity?: number }, world: (w: ReturnType<typeof createWorld>) => void = () => {}, seconds = 1, list = HARMONICS) {
    const forms = new MatterForms(), view = new WorldView(), w = createWorld(), material = createMaterial();
    const { response, audio } = voices(saw, 1, 1), snapshot = createSnapshot(partials(list));
    snapshot.acoustic.presence = 1;
    Object.assign(material, { continuity: set.continuity ?? 0, connectivity: set.connectivity ?? 0, angularity: set.angularity ?? 0 });
    Object.assign(snapshot.morphology, { periodicity: set.periodicity ?? 0, stability: set.stability ?? 1, harmonicity: set.harmonicity ?? 1 });
    for (let i = 0; i < seconds * 60; i++) {
      w.time += 1 / 60; world(w);
      view.update(w, NEUTRAL);
      forms.update(1 / 60, view, material, 1, audio, response, snapshot);
    }
    return { forms, view, material, snapshot, response, audio };
  }

  it('gives the matter to the forms by what the sound is made of, and never all of it', () => {
    expect(derive({}).forms.state).toMatchObject({ wave: 0, harmonic: 0 });
    const tone = derive({ continuity: 0.9, periodicity: 0.9 }).forms.state;
    expect(tone.wave).toBeGreaterThan(0.8); expect(tone.harmonic).toBe(0); expect(tone.closure).toBeGreaterThan(0.9);
    const chord = derive({ connectivity: 0.8 }).forms.state;
    expect(chord.harmonic).toBeGreaterThan(0.7); expect(chord.wave).toBe(0);
    const both = derive({ continuity: 1, connectivity: 1 }).forms.state;
    expect(both.wave + both.harmonic).toBeCloseTo(1 - FREE_SHARE, 6);
    expect(both.wave).toBeCloseTo(both.harmonic, 6);
    // A connected material without partials to connect has no network to form.
    expect(derive({ connectivity: 1, harmonicity: 0 }).forms.state.harmonic).toBe(0);
    // A continuous material is a wide ribbon only while the sound is steady.
    expect(derive({ continuity: 1, stability: 1 }).forms.state.ribbon).toBeGreaterThan(2);
    expect(derive({ continuity: 1, stability: 0.1 }).forms.state.ribbon).toBeLessThan(0.3);
  });

  it('lets go without a clock, and a release fractures the forms for a moment', () => {
    const r = derive({ continuity: 1, periodicity: 1 });
    expect(r.forms.state.wave).toBeGreaterThan(0.8);
    for (let i = 0; i < 120; i++) r.forms.update(1 / 60, r.view, r.material, 1, r.audio, r.response, undefined);
    // No experience: nothing is periodic or tonal as far as the forms know; the history stands still.
    expect(r.forms.state.closure).toBe(0);
    expect(r.forms.harmonic.active).toBe(0);
    const head = r.forms.signal.head;
    for (let i = 0; i < 60; i++) r.forms.update(1 / 60, r.view, r.material, 1, r.audio, r.response, undefined);
    expect(r.forms.signal.head).toBe(head);
    // A release the world went through 0.1 s ago, and the same one 4 s later.
    const fresh = derive({ continuity: 1 }, (w) => { w.releaseTime = w.time - 0.1; w.releaseStrength = 0.7; }).forms.state.fracture;
    const old = derive({ continuity: 1 }, (w) => { w.releaseTime = w.time - 4; w.releaseStrength = 0.7; }).forms.state.fracture;
    expect(fresh).toBeGreaterThan(0.8); expect(old).toBeLessThan(0.05);
    expect(derive({ continuity: 1 }).forms.state.fracture).toBe(0);
  });

  it('stored potential draws the curve taut, an open and travelling world deepens the history', () => {
    const rest = derive({ continuity: 1 }).forms.state, tense = derive({ continuity: 1 }, (w) => { w.potential = 1; }).forms.state;
    expect(tense.amplitude).toBeLessThan(rest.amplitude * 0.75);
    const open = derive({ continuity: 1 }, (w) => { w.openness = 1; w.speed = 4; }).forms.state;
    expect(open.depth).toBeGreaterThan(rest.depth * 2);
  });

  it('can be pinned to one state in development, and is bounded on corrupted input', () => {
    try {
      matterLab.form = 'harmonic';
      expect(derive({ continuity: 1, periodicity: 1 }).forms.state).toMatchObject({ wave: 0, harmonic: 1 - FREE_SHARE });
      matterLab.form = 'wave';
      expect(derive({ connectivity: 1 }).forms.state).toMatchObject({ wave: 1 - FREE_SHARE, harmonic: 0 });
      matterLab.form = 'particles';
      expect(derive({ continuity: 1, connectivity: 1 }).forms.state).toMatchObject({ wave: 0, harmonic: 0 });
    } finally { matterLab.form = 'auto'; }
    const forms = new MatterForms(), view = new WorldView(), w = createWorld(), material = createMaterial();
    const { response, audio } = voices(saw, 1, 1), snapshot = createSnapshot(partials(HARMONICS));
    for (const value of [NaN, Infinity, -Infinity, 1e12]) {
      material.continuity = material.connectivity = material.angularity = value;
      w.potential = w.openness = w.speed = w.releaseStrength = value; w.releaseTime = value;
      snapshot.morphology.periodicity = snapshot.morphology.stability = snapshot.morphology.harmonicity = value;
      view.update(w, NEUTRAL);
      forms.update(1 / 60, view, material, value, audio, response, snapshot);
      for (const x of forms.pack()) expect(Number.isFinite(x), `${value}`).toBe(true);
      expect(forms.state.wave + forms.state.harmonic).toBeLessThanOrEqual(1);
    }
  });
});
