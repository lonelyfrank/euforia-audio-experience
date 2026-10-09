import type { AudioFrame } from '../../types/audio';
import { RECORD, SCENE_FIELDS as F } from './layout';

/** Scene records kept: about a second at the default cadence (≈ 60 per second), more than the longest audio delay. */
const SLOTS = 64;
const SIZE = RECORD.scene;

/**
 * The scenes' graphic analysis as it arrives from the producer (the native
 * capture thread, the analysis worker): the latest scene records, each stamped
 * on the capture clock, and the copy of one of them into the `AudioFrame` the
 * scenes read. The analysis itself runs in Rust at a fixed cadence
 * (`spectrum_analysis::scene`); nothing is computed here.
 *
 * A rendered frame shows the record analysed nearest to `delay` samples
 * before the newest one, so the audio delay works as it did when the frame
 * loop analysed a delayed window. What lasts one analysis (the beat flag,
 * the transients) is not lost when a frame spans two records, and is not
 * repeated when two frames share one.
 */
export class SceneFeed {
  private readonly records = new Float64Array(SLOTS * SIZE);
  /** Records received since the last `clear`; record k lives in slot k % SLOTS. */
  received = 0;
  /** The record the last `read` showed (-1: none yet). */
  private shown = -1;

  /** Keeps the scene record encoded at `data[at]`. */
  push(data: Float64Array, at: number): void {
    const records = this.records;
    const to = (this.received % SLOTS) * SIZE;
    for (let i = 0; i < SIZE; i++) records[to + i] = data[at + i];
    this.received++;
  }

  clear(): void {
    this.received = 0;
    this.shown = -1;
  }

  /** Capture clock (samples) of the newest record, -1 while there is none. */
  get newest(): number {
    return this.received > 0 ? this.sampleOf(this.received - 1) : -1;
  }

  /**
   * Writes into `frame` the scene analysed nearest to `delay` samples before
   * the newest one. False while no record has arrived (the frame is left alone).
   * `beatResponse` false keeps `beat` and `beatPulse` at rest, as the setting asks.
   */
  read(frame: AudioFrame, delay: number, beatResponse: boolean): boolean {
    const newest = this.received - 1;
    if (newest < 0) return false;
    const oldest = Math.max(0, this.received - SLOTS);
    let chosen = newest;
    if (delay > 0) {
      const target = this.sampleOf(newest) - delay;
      while (chosen > oldest && Math.abs(this.sampleOf(chosen - 1) - target) <= Math.abs(this.sampleOf(chosen) - target)) chosen--;
    }
    const r = this.records;
    const at = (chosen % SLOTS) * SIZE;
    const shown = this.shown;
    this.shown = chosen;

    let beat = r[at + F.beat[0]] !== 0;
    let onset = r[at + F.onset[0]];
    let lowFlux = r[at + F.lowFlux[0]];
    let midFlux = r[at + F.midFlux[0]];
    let highFlux = r[at + F.highFlux[0]];
    if (chosen === shown) {
      // The same analysis as the previous frame (a display faster than the cadence): its beat was shown then.
      beat = false;
    } else if (chosen > shown) {
      // Analyses this frame skipped over: a beat or a transient in any of them belongs to this frame.
      for (let k = Math.max(shown + 1, oldest); k < chosen; k++) {
        const o = (k % SLOTS) * SIZE;
        if (r[o + F.beat[0]] !== 0) beat = true;
        if (r[o + F.onset[0]] > onset) onset = r[o + F.onset[0]];
        if (r[o + F.lowFlux[0]] > lowFlux) lowFlux = r[o + F.lowFlux[0]];
        if (r[o + F.midFlux[0]] > midFlux) midFlux = r[o + F.midFlux[0]];
        if (r[o + F.highFlux[0]] > highFlux) highFlux = r[o + F.highFlux[0]];
      }
    }

    frame.silent = r[at + F.silent[0]] !== 0;
    frame.centroidHz = r[at + F.centroidHz[0]];
    frame.rolloffHz = r[at + F.rolloffHz[0]];
    frame.spreadHz = r[at + F.spreadHz[0]];
    frame.rms = r[at + F.rms[0]];
    frame.volume = r[at + F.volume[0]];
    frame.peak = r[at + F.peak[0]];
    frame.bass = r[at + F.bass[0]];
    frame.lowMid = r[at + F.lowMid[0]];
    frame.mid = r[at + F.mid[0]];
    frame.highMid = r[at + F.highMid[0]];
    frame.treble = r[at + F.treble[0]];
    frame.energy = r[at + F.energy[0]];
    frame.beat = beatResponse && beat;
    frame.beatPulse = beatResponse ? r[at + F.beatPulse[0]] : 0;
    frame.onset = onset;
    frame.bpm = r[at + F.bpm[0]];
    frame.tempoConfidence = r[at + F.tempoConfidence[0]];
    frame.beatPhase = r[at + F.beatPhase[0]];
    frame.lowFlux = lowFlux;
    frame.midFlux = midFlux;
    frame.highFlux = highFlux;
    frame.flatness = r[at + F.flatness[0]];
    frame.loudness = r[at + F.loudness[0]];
    frame.lowDb = r[at + F.lowDb[0]];
    frame.midDb = r[at + F.midDb[0]];
    frame.highDb = r[at + F.highDb[0]];
    frame.bassVoice.pitch = r[at + F.bassPitch[0]];
    frame.bassVoice.clarity = r[at + F.bassClarity[0]];
    frame.leadVoice.pitch = r[at + F.leadPitch[0]];
    frame.leadVoice.clarity = r[at + F.leadClarity[0]];
    if (chosen !== shown) {
      copy(r, at + F.spectrum[0], frame.spectrum);
      copy(r, at + F.waveform[0], frame.waveform);
      copy(r, at + F.bassShape[0], frame.bassVoice.shape);
      copy(r, at + F.leadShape[0], frame.leadVoice.shape);
    }
    return true;
  }

  private sampleOf(record: number): number {
    return this.records[(record % SLOTS) * SIZE + F.sample[0]];
  }
}

function copy(from: Float64Array, at: number, to: Float32Array): void {
  for (let i = 0; i < to.length; i++) to[i] = from[at + i];
}
