import type { AnalysisFrame } from '../../audio/features/decode';
import { METER_PRIOR, METERS, PHRASES } from './knowledge';
import type { Grouping } from './MusicalClock';

/*
 * Structural memory: what the track has done, as numbers, for long enough to compare the present with it. No audio,
 * no spectra: per beat a small vector of measures the DSP already exports (spectral shape, level in the track's range,
 * attacks, percussive share, flatness, low end, chroma), per bar the mean of its beats. Fixed rings (256 beats, 64 bars:
 * two minutes at 128 BPM), a window that limits how far back the comparisons look, nothing allocated after construction.
 *
 * From them:
 * - grouping by change: where in the beat cycle the vectors change most (harmony, bass line, pattern restarts fall on
 *   downbeats in most music) gives beats per bar and where the bar starts — a second witness beside the tracker's
 *   low-end accents, which four kicks of equal weight leave silent;
 * - repetition: how alike the last bar is to the bars 1, 2, 4, 8 and 16 back, followed per lag; the shortest lag that
 *   explains it is the pattern, and a bar that departs from it is a pattern break;
 * - novelty and boundaries: how far the last bar (and the beat a bar opens with, against the beats the previous bars
 *   opened with) stands from what came before, on self-calibrating scales;
 * - phrases: boundaries are evidence for phrase lengths 4/8/16/32 at some offset; each hypothesis scores how much
 *   stronger the boundaries at its positions are than elsewhere, the style's priors weigh them, a "no phrase" hypothesis
 *   keeps them honest, and the posterior says which length, where, and how sure.
 */

/** Beat vector: 8 band shapes, level in the track's range, onset strength, attack density, percussive share, flatness, low-end share, 12 chroma. */
export const DIMS = 26;
const BEATS = 256;
const BARS = 64;
const LAGS = [1, 2, 4, 8, 16] as const;
/** Without a grid the memory still slices the sound, every this many seconds (free beats: no bars, no phrases). */
export const FREE_BEAT = 0.5;
/** Running statistics per event. */
const RATE = 0.15;
const LAG_RATE = 0.3;
/** Smallest deviation of the novelty scales, and the smallest distance that can be a boundary (vector units). */
const MIN_DEV = 0.03;
const MIN_BOUNDARY = 0.05;
/** The deviation of a scale is at least this share of its mean: a loop whose bars differ steadily is not novel. */
const RELATIVE_DEV = 0.35;
/** Comparisons a scale needs before it reports anything. */
const WARMUP = 4;
/** Phrase evidence: sharpness of the likelihood, prior of "no phrase structure". */
const PHRASE_BETA = 4;
const NO_PHRASE = 0.5;
/** Beats a grouping by change must lead before it is published. */
const GROUPING_HOLD = 2;

export interface MemoryReading {
  /** 0..1 how much the last bars repeat the pattern, its length in bars (0 unknown). */
  repetition: number;
  pattern: number;
  /** 0..1 novelty of the last bar, boundary strength of the last downbeat (bar index of that downbeat). */
  novelty: number;
  boundary: number;
  boundaryBar: number;
  /** Size (0..1) and capture time of the last pattern break (0: none since the last read). */
  patternBreak: number;
  breakTime: number;
  /** Phrase length (bars; 0 unknown), offset (a bar index that starts a phrase), confidence, the probability of no phrase structure. */
  phraseBars: number;
  phraseOffset: number;
  phraseConfidence: number;
  noPhrase: number;
  /** Means over the last bar (or 4 free beats): level position, low-end share (lowShare), attacks per second, presence. */
  level: number;
  low: number;
  density: number;
  presence: number;
  /** Per bar: change of level position, low end and attack density over the last 16 beats (linear fit). */
  levelSlope: number;
  lowSlope: number;
  densitySlope: number;
  /** The track's usual low end while it grooves (followed over a minute). */
  lowReference: number;
  beats: number;
  bars: number;
}

export class StructuralMemory {
  readonly reading: MemoryReading = {
    repetition: 0, pattern: 0, novelty: 0, boundary: 0, boundaryBar: -1, patternBreak: 0, breakTime: 0, phraseBars: 0, phraseOffset: 0, phraseConfidence: 0, noPhrase: 1,
    level: 0, low: 0, density: 0, presence: 0, levelSlope: 0, lowSlope: 0, densitySlope: 0, lowReference: 0, beats: 0, bars: 0,
  };
  /** Grouping read from where the vectors change (beats per bar 0 while undecided). */
  readonly grouping: Grouping = { beats: 0, offset: 0, confidence: 0 };
  /** Bars the comparisons look back over (from the configured window and the tempo). */
  windowBars = BARS;
  /** Phrase priors in force (the style blend's mix over PHRASES). */
  priors: ArrayLike<number> = [0.3, 0.4, 0.2, 0.1];
  // The beat being accumulated.
  private readonly sum = new Float64Array(DIMS);
  private count = 0;
  private sumLevel = 0;
  private sumLow = 0;
  private sumDensity = 0;
  private sumPresence = 0;
  private hops = 0;
  // Beats.
  private readonly beatVectors = new Float32Array(BEATS * DIMS);
  private readonly beatIndex = new Float64Array(BEATS);
  private readonly beatLevel = new Float32Array(BEATS);
  private readonly beatLow = new Float32Array(BEATS);
  private readonly beatDensity = new Float32Array(BEATS);
  private readonly beatPresence = new Float32Array(BEATS);
  private written = 0;
  // Grouping by change: per meter hypothesis, the change at each position of its cycle.
  /** Change of each beat from the one before (−1: not comparable), and scratch per position of a cycle. */
  private readonly beatChange = new Float32Array(BEATS).fill(-1);
  private readonly positionSum = new Float64Array(7);
  private readonly positionCount = new Uint16Array(7);
  private readonly meterScore = new Float32Array(METERS.length);
  private readonly meterOffset = new Int32Array(METERS.length);
  private candidate = 0;
  private held = 0;
  // Bars.
  private readonly barVectors = new Float32Array(BARS * DIMS);
  private barsWritten = 0;
  private barCount = 0;
  private readonly lagSimilarity = new Float32Array(LAGS.length);
  private scale = 0;
  private noveltyMean = 0;
  private noveltyDev = MIN_DEV;
  private boundaryMean = 0;
  private noveltyCount = 0;
  private boundaryCount = 0;
  /** How far the last three downbeats departed from what was established (newest first). */
  private readonly departures = new Float32Array(3);
  /** Boundary strength per bar index (ring), for the phrase hypotheses. */
  private readonly boundaries = new Float32Array(BARS);
  private readonly boundaryIndex = new Float64Array(BARS).fill(-1);
  private readonly posterior = new Float64Array(PHRASES.length + 1);
  private readonly vector = new Float64Array(DIMS);
  private readonly mean = new Float64Array(DIMS);
  private bars = 0;
  private barOffset = 0;
  private realBars = false;

  /** Typed memory held (bytes). */
  get bytes(): number {
    return this.beatVectors.byteLength + this.beatIndex.byteLength + 4 * this.beatLevel.byteLength + this.beatChange.byteLength + this.positionSum.byteLength + this.positionCount.byteLength + this.meterScore.byteLength + this.meterOffset.byteLength + this.barVectors.byteLength +
      this.lagSimilarity.byteLength + this.departures.byteLength + this.boundaries.byteLength + this.boundaryIndex.byteLength + this.posterior.byteLength + 3 * this.sum.byteLength;
  }

  reset(): void {
    this.sum.fill(0); this.count = this.sumLevel = this.sumLow = this.sumDensity = this.sumPresence = this.hops = 0;
    this.beatVectors.fill(0); this.beatIndex.fill(0); this.beatChange.fill(-1); this.beatLevel.fill(0); this.beatLow.fill(0); this.beatDensity.fill(0); this.beatPresence.fill(0);
    this.written = 0; this.reading.lowReference = 0;
    this.reanchor();
  }

  /** The grid was anchored anew: beat indices restart, so bars, grouping and phrases do too (the track's references stay). */
  reanchor(): void {
    this.meterScore.fill(0); this.meterOffset.fill(0); this.candidate = this.held = 0;
    this.grouping.beats = this.grouping.offset = this.grouping.confidence = 0;
    this.bars = 0; this.barOffset = 0; this.realBars = false;
    this.rebar();
    this.reading.beats = 0;
  }

  /**
   * Bars are counted in this grouping from now on (`real`: the grouping has evidence; otherwise bars of 4 for
   * comparisons only). A different grouping or downbeat makes every bar kept so far a different slice of the beats:
   * what was learned per bar starts over, the beats stay.
   */
  setBars(beats: number, offset: number, real: boolean): void {
    if (beats !== this.bars || offset !== this.barOffset) { this.bars = beats; this.barOffset = offset; this.rebar(); }
    this.realBars = real;
  }

  private rebar(): void {
    this.barVectors.fill(0); this.barsWritten = this.barCount = 0; this.lagSimilarity.fill(0); this.scale = 0;
    this.noveltyMean = this.boundaryMean = 0; this.noveltyDev = MIN_DEV; this.noveltyCount = this.boundaryCount = 0; this.departures.fill(0);
    this.boundaries.fill(0); this.boundaryIndex.fill(-1); this.posterior.fill(0);
    const r = this.reading;
    Object.assign(r, { repetition: 0, pattern: 0, novelty: 0, boundary: 0, boundaryBar: -1, patternBreak: 0, breakTime: 0, phraseBars: 0, phraseOffset: 0, phraseConfidence: 0, noPhrase: 1, bars: 0 });
  }

  /** One analysis hop: its measures join the beat being accumulated (`low`: the low end's share, lowShare()). */
  hop(a: Readonly<AnalysisFrame>, low: number): void {
    this.hops++;
    const presence = a.silent ? 0 : a.presence;
    this.sumPresence += presence;
    if (presence < 0.06) return;
    let top = -200;
    for (let b = 0; b < 8; b++) top = Math.max(top, a.bandDb[b]);
    const s = this.sum;
    for (let b = 0; b < 8; b++) s[b] += clamp01(1 + (a.bandDb[b] - top) / 40);
    s[8] += a.loudnessPosition; s[9] += a.onsetStrength; s[10] += Math.min(1, a.onsetDensity / 8); s[11] += a.percussiveShare;
    s[12] += a.flatness; s[13] += low;
    for (let c = 0; c < 12; c++) s[14 + c] += a.chroma[c] * a.chromaConfidence;
    this.sumLevel += a.loudnessPosition; this.sumLow += low; this.sumDensity += a.onsetDensity;
    this.count++;
  }

  /**
   * Closes the beat being accumulated as musical beat `index` (free: a slice without a grid), at capture time `time`.
   * Returns true when it closed a bar.
   */
  closeBeat(index: number, time: number, free: boolean): boolean {
    const n = this.count, hops = Math.max(1, this.hops);
    const slot = this.written % BEATS, v = this.beatVectors, at = slot * DIMS;
    for (let d = 0; d < DIMS; d++) v[at + d] = n > 0 ? this.sum[d] / n : 0;
    this.beatIndex[slot] = index;
    this.beatLevel[slot] = n > 0 ? this.sumLevel / n : 0; this.beatLow[slot] = n > 0 ? this.sumLow / n : 0;
    this.beatDensity[slot] = n > 0 ? this.sumDensity / n : 0; this.beatPresence[slot] = this.sumPresence / hops;
    this.sum.fill(0); this.count = this.sumLevel = this.sumLow = this.sumDensity = this.sumPresence = this.hops = 0;
    this.written++;
    const r = this.reading;
    r.beats = Math.min(this.written, BEATS);
    this.recent(free ? 4 : this.bars || 4);
    const previous = (this.written - 2 + BEATS) % BEATS;
    this.beatChange[slot] = !free && this.written >= 2 && this.beatPresence[slot] >= 0.3 && this.beatPresence[previous] >= 0.3 && this.beatIndex[previous] === index - 1
      ? this.distance(slot, previous) : -1;
    if (free || this.beatPresence[slot] < 0.3) return false;
    this.groupByChange();
    // The track's usual low end where it has one (a build or a break without it does not lower it), fading over minutes.
    const low = this.beatLow[slot];
    if (low >= 0.4) r.lowReference += (low - r.lowReference) * (r.lowReference === 0 ? 1 : 0.1);
    else r.lowReference *= 0.998;
    const g = this.bars || 4, position = (((index - this.barOffset) % g) + g) % g;
    if (position === 0 && this.bars > 0) this.boundary(index, g);
    if (position !== g - 1 || this.written < g) return false;
    this.closeBar(time, g);
    return true;
  }

  /** The current bar index in the grouping (−1 without one), for the phrase position. */
  barOf(beat: number): number {
    return this.bars > 0 ? Math.floor((beat - this.barOffset) / this.bars) : -1;
  }

  /** Means of the last `n` beats and the slopes over the last 16. */
  private recent(n: number): void {
    const r = this.reading, count = Math.min(n, this.written);
    let level = 0, low = 0, density = 0, presence = 0;
    for (let k = 1; k <= count; k++) {
      const i = (this.written - k) % BEATS;
      level += this.beatLevel[i]; low += this.beatLow[i]; density += this.beatDensity[i]; presence += this.beatPresence[i];
    }
    const c = Math.max(1, count);
    r.level = level / c; r.low = low / c; r.density = density / c; r.presence = presence / c;
    // Slopes over 8 to 16 beats of sound: fewer, or a silence among them, say how the music started, not where it goes.
    let span = 0;
    while (span < Math.min(16, this.written) && this.beatPresence[(this.written - 1 - span) % BEATS] >= 0.5) span++;
    const perBar = this.bars || 4, valid = span >= 8;
    r.levelSlope = valid ? this.slope(this.beatLevel, span) * perBar : 0;
    r.lowSlope = valid ? this.slope(this.beatLow, span) * perBar : 0;
    r.densitySlope = valid ? this.slope(this.beatDensity, span) * perBar : 0;
  }

  /** Least-squares slope per beat of the last `span` values of a ring. */
  private slope(ring: Float32Array, span: number): number {
    if (span < 4) return 0;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = 0; k < span; k++) {
      const x = k, y = ring[(this.written - span + k) % BEATS];
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const den = span * sxx - sx * sx;
    return den > 0 ? (span * sxy - sx * sy) / den : 0;
  }

  /**
   * Where the change falls in the beat cycle, over the last 64 beats: for each grouping, the position whose beats change
   * most, against the mean change. A clear winner, held for two of its cycles, is the grouping; the universal prior
   * (more music groups in 4 than in 7) only breaks near ties.
   */
  private groupByChange(): void {
    const span = Math.min(64, this.written, BEATS);
    if (span < 24) return;
    let total = 0, n = 0;
    for (let k = 1; k <= span; k++) { const c = this.beatChange[(this.written - k) % BEATS]; if (c >= 0) { total += c; n++; } }
    if (n < 24 || total <= 0) return;
    const mean = total / n, scores = this.meterScore, offsets = this.meterOffset, sums = this.positionSum, counts = this.positionCount;
    let spread = 0;
    for (let k = 1; k <= span; k++) { const c = this.beatChange[(this.written - k) % BEATS]; if (c >= 0) spread += (c - mean) ** 2; }
    const sd = Math.sqrt(spread / n) || 1e-4;
    let best = 0;
    for (let h = 0; h < METERS.length; h++) {
      const m = METERS[h];
      sums.fill(0); counts.fill(0);
      for (let k = 1; k <= span; k++) {
        const i = (this.written - k) % BEATS, c = this.beatChange[i];
        if (c < 0) continue;
        const p = ((this.beatIndex[i] % m) + m) % m;
        sums[p] += c; counts[p]++;
      }
      let top = -Infinity, at = 0;
      for (let p = 0; p < m; p++) { const v = counts[p] > 0 ? sums[p] / counts[p] : 0; if (v > top) { top = v; at = p; } }
      // How far the strongest position stands above the mean, in standard errors, less what the strongest of m
      // positions would show with no grouping at all (≈ √(2 ln m)): longer cycles do not win by having more positions.
      const z = (top - mean) / (sd / Math.sqrt(Math.max(1, counts[at]))) - Math.sqrt(2 * Math.log(m));
      scores[h] = Math.max(0, z) * (0.85 + 0.15 * METER_PRIOR[h] / METER_PRIOR[1]);
      offsets[h] = at;
      if (scores[h] > scores[best]) best = h;
    }
    let runner = 0;
    for (let h = 0; h < METERS.length; h++) if (h !== best) runner = Math.max(runner, scores[h]);
    if (best === this.candidate) this.held++; else { this.candidate = best; this.held = 0; }
    const m = METERS[best], confidence = clamp01((scores[best] - runner) / 1.2) * clamp01(scores[best] / 1.2);
    // Beats whose index is `offset` modulo the grouping are downbeats.
    if (this.held >= GROUPING_HOLD * m) { this.grouping.beats = m; this.grouping.offset = offsets[best]; }
    this.grouping.confidence += ((this.grouping.beats === m && offsets[best] === this.grouping.offset ? confidence : 0) - this.grouping.confidence) * RATE;
  }

  /**
   * Is the bar that opens here a boundary? A boundary is where the music stops repeating what it has established: the
   * beat this bar opens with, against the closest of the beats the last eight bars opened with (a pattern of any length
   * up to eight bars has its match there; something new has none). The bars after it are new too until the new pattern
   * has come round once, so only the onset of the departure counts. On a self-calibrating scale.
   */
  private boundary(index: number, g: number): void {
    const r = this.reading, slot = (this.written - 1) % BEATS;
    let distance = Infinity, found = 0;
    for (let j = 1; j <= 8; j++) {
      const back = this.written - 1 - j * g;
      if (back < 0 || j * g >= BEATS) break;
      const i = back % BEATS;
      if (this.beatPresence[i] < 0.3 || this.beatIndex[i] !== index - j * g) continue;
      distance = Math.min(distance, this.distance(slot, i)); found++;
    }
    if (found < 2) return;
    // The scale is what a repetition usually differs by (learned only from bars that repeat: a departure must not
    // raise the bar it is measured against); a departure is how many of those it differs by.
    const count = ++this.boundaryCount;
    if (count <= WARMUP) this.boundaryMean = count === 1 ? distance : Math.min(this.boundaryMean, distance);
    else if (distance <= 2 * this.boundaryMean + MIN_DEV) this.boundaryMean += (distance - this.boundaryMean) * RATE;
    const departure = Math.max(0, (distance - this.boundaryMean) / Math.max(MIN_DEV, this.boundaryMean));
    // The bars after a boundary are new too until the new pattern has come round once: only the onset of the episode
    // counts, against the largest departure of the three bars before.
    const d = this.departures, onset = departure - Math.max(d[0], d[1], d[2]);
    d[2] = d[1]; d[1] = d[0]; d[0] = departure;
    const strength = count > WARMUP && distance >= MIN_BOUNDARY ? clamp01(onset / 4) : 0;
    const bar = this.barOf(index);
    r.boundary = strength; r.boundaryBar = bar;
    const at = ((bar % BARS) + BARS) % BARS;
    this.boundaries[at] = strength; this.boundaryIndex[at] = bar;
    if (this.realBars) this.phrases(bar);
  }

  /** Closes the bar made of the last `g` beats: repetition per lag, pattern, novelty, pattern break. */
  private closeBar(time: number, g: number): void {
    const r = this.reading, at = (this.barsWritten % BARS) * DIMS;
    this.vector.fill(0);
    for (let k = 1; k <= g; k++) {
      const i = ((this.written - k) % BEATS) * DIMS;
      for (let d = 0; d < DIMS; d++) this.vector[d] += this.beatVectors[i + d] / g;
    }
    for (let d = 0; d < DIMS; d++) this.barVectors[at + d] = this.vector[d];
    this.barsWritten++; this.barCount++;
    r.bars = Math.min(this.barsWritten, BARS);
    const available = Math.min(this.barCount, this.windowBars, BARS) - 1;
    if (available < 1) return;
    // Repetition: similarity to the bars one pattern back, on a scale set by how much neighbouring bars differ.
    const near = this.barDistance(1);
    this.scale += (Math.max(0.02, near) - this.scale) * (this.scale === 0 ? 1 : RATE);
    let best = 0;
    for (let l = 0; l < LAGS.length; l++) {
      if (LAGS[l] > available) continue;
      const similarity = Math.exp(-this.barDistance(LAGS[l]) / this.scale);
      this.lagSimilarity[l] += (similarity - this.lagSimilarity[l]) * LAG_RATE;
      best = Math.max(best, this.lagSimilarity[l]);
    }
    const previous = r.pattern;
    r.repetition = best; r.pattern = 0;
    for (let l = 0; l < LAGS.length; l++) if (best >= 0.5 && this.lagSimilarity[l] >= 0.9 * best) { r.pattern = LAGS[l]; break; }
    // A bar that departs from a pattern that held.
    if (previous > 0 && previous <= available) {
      const l = LAGS.indexOf(previous as typeof LAGS[number]), held = this.lagSimilarity[l];
      const now = Math.exp(-this.barDistance(previous) / this.scale);
      if (held >= 0.6 && now < held - 0.35) { r.patternBreak = held - now; r.breakTime = time; }
    }
    // Novelty of the bar against the mean of the four before it.
    this.mean.fill(0);
    const back = Math.min(4, available);
    for (let j = 1; j <= back; j++) {
      const i = ((this.barsWritten - 1 - j) % BARS) * DIMS;
      for (let d = 0; d < DIMS; d++) this.mean[d] += this.barVectors[i + d] / back;
    }
    let distance = 0;
    for (let d = 0; d < DIMS; d++) distance += (this.vector[d] - this.mean[d]) ** 2;
    distance = Math.sqrt(distance / DIMS);
    const z = (distance - this.noveltyMean) / Math.max(MIN_DEV, this.noveltyDev, RELATIVE_DEV * this.noveltyMean);
    this.noveltyMean += (distance - this.noveltyMean) * (this.noveltyCount === 0 ? 1 : RATE);
    this.noveltyDev += (Math.abs(distance - this.noveltyMean) - this.noveltyDev) * RATE;
    r.novelty = ++this.noveltyCount > WARMUP && distance >= MIN_BOUNDARY ? clamp01(z / 4) : 0;
  }

  /**
   * Phrase posterior after the boundary of bar `bar`: for each length, the offset whose boundaries stand out most; its
   * likelihood grows with that contrast and with how many times it was seen; the style's priors weigh the lengths.
   */
  private phrases(bar: number): void {
    const r = this.reading, window = Math.min(this.windowBars, BARS), from = bar - window + 1;
    let all = 0, n = 0;
    for (let i = 0; i < BARS; i++) if (this.boundaryIndex[i] >= from && this.boundaryIndex[i] <= bar) { all += this.boundaries[i]; n++; }
    if (n < 4) return;
    const mean = all / n;
    let bestLength = 0, bestOffset = 0, bestHits = 0, logBest = -Infinity;
    const log = this.posterior;
    for (let p = 0; p < PHRASES.length; p++) {
      const L = PHRASES[p];
      let ll = -Infinity, offsetAt = 0, hitsAt = 0;
      for (let o = 0; o < L; o++) {
        let sum = 0, hits = 0;
        for (let i = 0; i < BARS; i++) {
          const b = this.boundaryIndex[i];
          if (b < from || b > bar || ((b - o) % L + L) % L !== 0) continue;
          sum += this.boundaries[i]; hits++;
        }
        if (hits === 0) continue;
        const score = PHRASE_BETA * (sum / hits - mean) * Math.sqrt(hits);
        if (score > ll) { ll = score; offsetAt = o; hitsAt = hits; }
      }
      log[p] = Math.log(Math.max(1e-6, this.priors[p])) + (Number.isFinite(ll) ? ll : -Infinity);
      if (log[p] > logBest) { logBest = log[p]; bestLength = L; bestOffset = offsetAt; bestHits = hitsAt; }
    }
    log[PHRASES.length] = Math.log(NO_PHRASE);
    let top = -Infinity, total = 0;
    for (let i = 0; i <= PHRASES.length; i++) top = Math.max(top, log[i]);
    for (let i = 0; i <= PHRASES.length; i++) total += Math.exp(log[i] - top);
    const best = Math.exp(logBest - top) / total;
    r.noPhrase = Math.exp(log[PHRASES.length] - top) / total;
    // A length is believed only once a boundary has come back at its offset.
    r.phraseConfidence = best * (bestHits >= 2 ? 1 : 0.4);
    r.phraseBars = bestLength; r.phraseOffset = bestOffset;
  }

  private distance(a: number, b: number): number {
    let sum = 0;
    const v = this.beatVectors;
    for (let d = 0; d < DIMS; d++) sum += (v[a * DIMS + d] - v[b * DIMS + d]) ** 2;
    return Math.sqrt(sum / DIMS);
  }

  /** Distance of the last bar from the bar `lag` bars before it. */
  private barDistance(lag: number): number {
    const a = ((this.barsWritten - 1) % BARS) * DIMS, b = ((this.barsWritten - 1 - lag) % BARS) * DIMS;
    let sum = 0;
    for (let d = 0; d < DIMS; d++) sum += (this.barVectors[a + d] - this.barVectors[b + d]) ** 2;
    return Math.sqrt(sum / DIMS);
  }
}

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);

/**
 * The low end's share of what is heard (0..1): the sub band against the total level of the bands, as the DSP's own
 * structure compares them (native/analysis/src/structure.rs). Not its activity above the floor: a noise riser fills
 * every band above its floor, yet leaves the sub 20–40 dB under the level, where a kick and a bass keep it within a
 * few dB. −20 dB and below reads 0, −4 dB and above 1.
 */
export function lowShare(a: Readonly<AnalysisFrame>): number {
  let power = 0;
  for (let b = 0; b < 8; b++) power += 10 ** (a.bandDb[b] / 10);
  if (!(power > 1e-12)) return 0;
  return clamp01((a.bandDb[0] - 10 * Math.log10(power) + 20) / 16);
}
