import { describe, expect, it } from 'vitest';
import { SignalGenerator, type TestSignal } from '../audio/capture/testSignals';
import { WasmAnalysis } from '../audio/features/WasmAnalysis';
import { CueScheduler } from '../dynamics/CueScheduler';
import { Dynamics } from '../dynamics/Dynamics';
import { FlashGuard } from '../dynamics/FlashGuard';
import { RhythmGate } from '../timing/RhythmGate';

/**
 * Test bench of the whole rig without rendering: synthetic audio with known
 * kick times → the Rust analysis (WASM) in 10 ms capture batches → rhythm
 * gate → cue scheduler (with the flash guard) → Dynamics, read once per
 * rendered frame at 30, 60 and 144 fps. Models a perfect clock and no output
 * latency: the frame at audio time T has heard everything captured until T.
 * Measures when the fixture (the glow pulse) crosses its visible threshold
 * after each kick, and whether the values agree across frame rates.
 */

const SR = 48000;
const BATCH = 480;
/** The fixture is "on" at this level (half its peak). */
const THRESHOLD = 0.5;
/** Agreed analysis-side threshold: a scheduled hit lands this close to the kick. */
const HIT_TOLERANCE = 0.01;
/** Kicks before this (s) are the tracker locking on: not measured. */
const SETTLE = 8;

interface RigRun {
  fps: number;
  /** Per measured kick: delay (s) from the kick to the first frame showing the fixture on. */
  delays: number[];
  /** Per measured kick: distance (s) to the nearest scheduled hit. */
  hitErrors: number[];
  /** Glow value at every 1/30 s (the grid all frame rates share). */
  grid: Map<number, number>;
  /** Every scheduled hit time after the settling time. */
  hits: number[];
}

async function runRig(signal: TestSignal, bpm: number, fps: number, seconds: number): Promise<RigRun> {
  const analysis = await WasmAnalysis.create(SR, 1);
  const generator = new SignalGenerator(signal, SR);
  const dynamics = new Dynamics();
  const glow = dynamics.channel('glow', 'flash');
  const cues = new CueScheduler(dynamics, glow, true, new FlashGuard());
  const gate = new RhythmGate();
  const chunk = new Float32Array(BATCH);
  const { decoder } = analysis;
  let captured = 0;
  const frames: [number, number][] = [];
  const grid = new Map<number, number>();
  const hitTimes = new Set<number>();
  const total = Math.round(seconds * fps);
  for (let f = 1; f <= total; f++) {
    const t = f / fps;
    decoder.begin();
    while ((captured + BATCH) / SR <= t + 1e-9) {
      generator.fill(chunk, 0, BATCH);
      analysis.push(chunk);
      captured += BATCH;
    }
    const frame = decoder.frame;
    const weight = gate.update(frame.beatConfidence * Math.min(1, frame.presence * 2), 1 / fps);
    cues.update(frame, weight, decoder.onsets.items, decoder.onsets.count, decoder.sections.items, decoder.sections.count);
    for (let i = 0; i < cues.hits.size; i++) if (cues.hits.times[i] > 0) hitTimes.add(cues.hits.times[i]);
    dynamics.advance(t);
    const value = dynamics.value(glow);
    frames.push([t, value]);
    const tick = Math.round(t * 30);
    if (Math.abs(t * 30 - tick) < 1e-6) grid.set(tick, value);
  }
  analysis.dispose();

  const delays: number[] = [];
  const hitErrors: number[] = [];
  const period = 60 / bpm;
  const scheduled = [...hitTimes];
  for (let k = Math.ceil(SETTLE / period) * period; k < seconds - 1; k += period) {
    const shown = frames.find(([t, v]) => t >= k - 0.01 && v >= THRESHOLD);
    delays.push(shown ? shown[0] - k : Infinity);
    hitErrors.push(Math.min(...scheduled.map((h) => Math.abs(h - k))));
  }
  return { fps, delays, hitErrors, grid, hits: scheduled.filter((h) => h >= SETTLE).sort((x, y) => x - y) };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const ms = (s: number) => `${(s * 1000).toFixed(1)} ms`;

describe('rig bench: kick → fixture threshold', { timeout: 120000 }, () => {
  for (const [signal, bpm] of [['beat124', 124], ['beat174', 174]] as const) {
    it(`${signal}: the fixture is on within a frame of each kick, the same at 30, 60 and 144 fps`, async () => {
      const runs: RigRun[] = [];
      for (const fps of [30, 60, 144]) runs.push(await runRig(signal, bpm, fps, 20));
      for (const r of runs) {
        const frame = 1 / r.fps;
        console.log(
          `${signal} @${r.fps} fps: hit − kick median ${ms(median(r.hitErrors))}, max ${ms(Math.max(...r.hitErrors))}; ` +
            `kick → on median ${ms(median(r.delays))}, max ${ms(Math.max(...r.delays))} (frame ${ms(frame)}), ${r.delays.length} kicks`,
        );
        // Analysis side: every kick has a scheduled hit within the agreed 10 ms.
        expect(Math.max(...r.hitErrors)).toBeLessThanOrEqual(HIT_TOLERANCE);
        // End to end: the fixture is on by the first frame after its hit (one frame of quantization on top of the hit's error).
        r.delays.forEach((d, i) => expect(d - r.hitErrors[i]).toBeLessThanOrEqual(frame + 1e-6));
      }
      // Same values at different frame rates: compare on the 1/30 s grid all of them share. The
      // Dynamics layer is exact for the same events; what may differ is the events themselves
      // (a predicted beat is scheduled from whichever frame first sees it, the gate ramps per frame).
      const [a, ...others] = runs;
      for (const r of others) {
        let worst = 0;
        let compared = 0;
        for (const [tick, value] of a.grid) {
          const other = r.grid.get(tick);
          if (other === undefined || tick < SETTLE * 30) continue;
          worst = Math.max(worst, Math.abs(other - value));
          compared++;
        }
        const shift = Math.max(...a.hits.map((h) => Math.min(...r.hits.map((x) => Math.abs(x - h)))));
        console.log(`${signal}: 30 vs ${r.fps} fps, ${compared} shared instants: max |Δ value| ${worst.toExponential(2)}, max hit shift ${ms(shift)}`);
        expect(compared).toBeGreaterThan(60);
        expect(shift).toBeLessThan(0.002);
        expect(worst).toBeLessThan(0.02);
      }
    });
  }
});

describe('rig bench: dynamics presets', () => {
  it('step responses agree at 30, 60 and 144 fps', () => {
    const rows: string[] = [];
    for (const type of ['flash', 'hit', 'pulse', 'swing', 'glide', 'drift', 'level', 'sparkle', 'swell'] as const) {
      // Read on every frame; recorded on the 1/6 s grid that 30, 60 and 144 fps share (and at 1 kHz for the table).
      const curves = [30, 60, 144, 1000].map((fps) => {
        const d = new Dynamics();
        const c = d.channel('x', type);
        d.advance(0);
        if (type === 'flash' || type === 'hit') d.impulse(c, 1, 0);
        else d.setTarget(c, 1, 0);
        const shared: number[] = [];
        const all: number[] = [];
        for (let f = 1; f <= 30 * fps; f++) {
          d.advance(f / fps);
          all.push(d.value(c));
          if ((f * 6) % fps === 0) shared.push(d.value(c));
        }
        return { shared, all };
      });
      for (const curve of curves.slice(1, 3)) curve.shared.forEach((v, i) => expect(v).toBeCloseTo(curves[0].shared[i], 9));
      // At 1 ms: 90% rise (10% fall for envelopes), overshoot, 2% settle.
      const ref = curves[3].all;
      const envelope = type === 'flash' || type === 'hit';
      const crossing = ref.findIndex((v) => (envelope ? v <= 0.1 : v >= 0.9));
      let settle = 0;
      ref.forEach((v, i) => {
        if (Math.abs(v - (envelope ? 0 : 1)) > 0.02) settle = (i + 1) / 1000;
      });
      const overshoot = envelope ? 0 : Math.max(...ref) - 1;
      rows.push(`${type.padEnd(8)} ${envelope ? 'fall' : 'rise'} ${((crossing + 1) / 1000).toFixed(3)} s  overshoot ${(overshoot * 100).toFixed(1)}%  settle ${settle.toFixed(3)} s`);
    }
    console.log(rows.join('\n'));
  });
});
