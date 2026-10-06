import { describe, expect, it } from 'vitest';
import { SignalGenerator } from '../audio/capture/testSignals';
import { parseBeats, parseWav, replay, type Pcm } from './replay';

/*
 * Always: the harness itself on a synthetic build/drop (WAV round trip,
 * report sanity, invariance of the presented world to render rate and
 * analysis batching on the full PCM → WASM → experience → world path).
 *
 * With EUFORIA_AUDIO_EXPERIENCE_CORPUS=<dir> (`EUFORIA_AUDIO_EXPERIENCE_CORPUS=~/euforia-audio-experience-corpus npm run replay`): every
 * `<name>.wav` in the directory (optional `<name>.beats`, optional
 * `corpus.json` {"<name>": {"style": "...", "tags": ["no-percussion", …]}})
 * is replayed; traces and reports land in `<dir>/euforia-audio-experience-report/`. Recordings
 * stay local: never commit copyrighted audio.
 */

const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const corpus = env.EUFORIA_AUDIO_EXPERIENCE_CORPUS;

function wav(pcm: Pcm): ArrayBuffer {
  const frames = pcm.samples.length / pcm.channels;
  const buffer = new ArrayBuffer(44 + pcm.samples.length * 2);
  const view = new DataView(buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < 4; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + pcm.samples.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, pcm.channels, true);
  view.setUint32(24, pcm.sampleRate, true); view.setUint32(28, pcm.sampleRate * pcm.channels * 2, true);
  view.setUint16(32, pcm.channels * 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, frames * pcm.channels * 2, true);
  for (let i = 0; i < pcm.samples.length; i++) view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(pcm.samples[i] * 32767))), true);
  return buffer;
}

describe('real-music replay harness', () => {
  it('replays a recording through the live path and reports behaviour; the world is invariant to fps and batching', { timeout: 120000 }, async () => {
    const sampleRate = 48000, seconds = 20;
    const samples = new Float32Array(seconds * sampleRate * 2);
    new SignalGenerator('buildDrop', sampleRate).fillStereo(samples, seconds * sampleRate);
    const pcm = parseWav(wav({ sampleRate, channels: 2, samples }));
    expect(pcm.channels).toBe(2);
    expect(pcm.samples.length).toBe(samples.length);
    expect(Math.abs(pcm.samples[1000] - samples[1000])).toBeLessThan(1 / 16000);
    const live = await replay(pcm, null, { fps: 60, batch: 480 });
    const r = live.report;
    expect(r.seconds).toBe(20);
    expect(r.beats as number).toBeGreaterThan(10);
    expect(r.worldEnergyMax as number).toBeGreaterThan(0);
    expect(r.worldSaturatedShare as number).toBeLessThan(0.5);
    expect(r.worldMaxRadialStepPerFrame as number).toBeLessThan(0.1);
    expect(live.trace.length).toBeGreaterThan(300);
    expect(live.trace.toCsv().split('\n')[0]).toContain('worldEnergy');
    const fast = await replay(pcm, null, { fps: 144, batch: 2048 });
    expect(fast.grid.length).toBe(live.grid.length);
    for (let i = 0; i < live.grid.length; i++) expect(fast.grid[i]).toBeCloseTo(live.grid[i], 8);
  });

  it('scores beats against annotations like the Rust corpus tool', () => {
    expect(parseBeats('0.5 1\n1.0 2\n# comment\n1.5\t3\n')).toEqual([{ time: 0.5, position: 1 }, { time: 1, position: 2 }, { time: 1.5, position: 3 }]);
  });

  it.skipIf(!corpus)('replays the local corpus in EUFORIA_AUDIO_EXPERIENCE_CORPUS', { timeout: 3600_000 }, async () => {
    const fs = await import(/* @vite-ignore */ 'node:fs' as string);
    const path = await import(/* @vite-ignore */ 'node:path' as string);
    const dir = corpus!.replace(/^~(?=\/)/, env.HOME ?? '~');
    const out = path.join(dir, 'euforia-audio-experience-report');
    fs.mkdirSync(out, { recursive: true });
    const manifestPath = path.join(dir, 'corpus.json');
    const manifest: Record<string, { style?: string; tags?: string[] }> = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
    const names = (fs.readdirSync(dir) as string[]).filter((n) => /\.wav$/i.test(n)).sort();
    expect(names.length).toBeGreaterThan(0);
    const summary: Record<string, unknown>[] = [];
    for (const file of names) {
      const name = file.replace(/\.wav$/i, '');
      const bytes = fs.readFileSync(path.join(dir, file));
      const pcm = parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const beatsPath = path.join(dir, `${name}.beats`);
      const beats = fs.existsSync(beatsPath) ? parseBeats(fs.readFileSync(beatsPath, 'utf8')) : null;
      const { report, trace } = await replay(pcm, beats);
      // Style and tags organise the report only; the engine never sees them.
      const row = { name, style: manifest[name]?.style ?? '', tags: (manifest[name]?.tags ?? []).join(' '), ...report };
      fs.writeFileSync(path.join(out, `${name}.csv`), trace.toCsv());
      fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(row, null, 2));
      summary.push(row);
      console.log(`${name}: ${JSON.stringify(report)}`);
      // Physical invariants hold on any music.
      expect(report.worldSaturatedShare as number).toBeLessThan(0.9);
      expect(report.worldMaxRadialStepPerFrame as number).toBeLessThan(0.2);
    }
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  });
});
