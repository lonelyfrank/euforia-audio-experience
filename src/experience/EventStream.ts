/**
 * Discrete audio/experience events, separate from the continuous state.
 * Every event carries the capture time of the samples that produced it, never
 * the time it was decoded or presented. Ordered by audio time: events can
 * arrive late (an onset is reported a hop after its peak, a section a beat
 * after its downbeat, a build peak once the decline confirms it), and are
 * inserted where they belong. Bounded ring, allocation-free after construction.
 */
export const EVENT_TYPES = [
  'onset', 'beat', 'downbeat', 'impact', 'silenceStart', 'silenceEnd', 'drop', 'buildPeak', 'sectionBoundary', 'phraseBoundary',
] as const;
export type AudioEventType = typeof EVENT_TYPES[number];

export interface AudioEvent {
  type: AudioEventType;
  /** Capture clock (s). */
  audioTime: number;
  /** 0..1, type-specific: attack strength, abruptness of a silence, released potential … */
  strength: number;
  /** 0..1: how much the evidence supports the event (a weak grid gives weak beats). */
  confidence: number;
  /** Energy band 0..7 (onsets: region 0 low, 1 mid, 2 high mapped to 1, 3, 5), -1 when broadband. */
  band: number;
  /** 0..1: how much the moment matters for the form (novelty, stored tension). */
  structuralWeight: number;
  /** Seconds the event spans (silenceEnd: the silence's length; 0 for instants). */
  duration: number;
  /**
   * 0..1: how far the event stands out of the session's recent events of its kind (impacts and drops, rated by the
   * adaptive calibration: 0 a typical one, 0.5 a usual accent, 1 far beyond those); for the other types, its strength.
   * Relative, never a level.
   */
  significance: number;
  /** Arrival order, for consumers that must not miss late insertions. */
  seq: number;
}

/** A consumer's position in the stream: last heard time and last arrival seen, in a stream epoch. */
export interface EventCursor {
  time: number;
  seq: number;
  epoch?: number;
  /**
   * While the heard moment is behind `time` (it went back: a latency raised, the clocks re-estimated): how far it has
   * come since, and the arrivals that were there before it went back. Kept by the stream.
   */
  low?: number;
  lowSeq?: number;
}

const CAPACITY = 256;

export class EventStream {
  private readonly slots: AudioEvent[] = Array.from({ length: CAPACITY }, () => ({
    type: 'onset', audioTime: 0, strength: 0, confidence: 0, band: -1, structuralWeight: 0, duration: 0, significance: 0, seq: 0,
  }));
  /** Index of the oldest event, and how many are stored (in audio-time order from `head`). */
  private head = 0;
  count = 0;
  /** Arrivals so far (the newest event's `seq`). */
  seq = 0;
  /** Oldest events dropped to make room (the ring is bounded). */
  evicted = 0;
  /** Increments on reset: cursors from before it start over. */
  epoch = 0;

  push(type: AudioEventType, audioTime: number, strength: number, confidence: number, band = -1, structuralWeight = 0, duration = 0, significance = strength): void {
    if (this.count === CAPACITY) {
      this.head = (this.head + 1) % CAPACITY;
      this.count--;
      this.evicted++;
    }
    // Insertion from the tail: late events move back past the few newer ones.
    let at = this.count;
    while (at > 0 && this.at(at - 1).audioTime > audioTime) {
      Object.assign(this.at(at), this.at(at - 1));
      at--;
    }
    const e = this.at(at);
    e.type = type; e.audioTime = audioTime; e.strength = strength; e.confidence = confidence;
    e.band = band; e.structuralWeight = structuralWeight; e.duration = duration; e.significance = significance; e.seq = ++this.seq;
    this.count++;
  }

  /** The i-th stored event in audio-time order (0 = oldest). */
  at(i: number): AudioEvent {
    return this.slots[(this.head + i) % CAPACITY];
  }

  /**
   * Visits, in audio-time order, the events heard by `heard` that `cursor` has
   * not seen: newer than its time, or arrived after it with an older time
   * (late insertions are delivered late rather than lost). Advances the cursor.
   *
   * `heard` may go back a little (the output latency was raised, the clock mapping re-estimated). What was shown
   * before that is not shown again, and what arrives while the heard moment catches up is delivered when it is heard:
   * for those arrivals the cursor keeps how far the heard moment has come since it went back.
   */
  forEachHeard(cursor: EventCursor, heard: number, visit: (event: AudioEvent) => void): void {
    if (cursor.epoch !== this.epoch) {
      // The stream restarted (session or analysis gap): its clock and arrivals start over.
      cursor.time = -Infinity; cursor.seq = 0; cursor.epoch = this.epoch; cursor.low = undefined;
    }
    const low = cursor.low, lowSeq = cursor.lowSeq ?? 0;
    for (let i = 0; i < this.count; i++) {
      const e = this.at(i);
      if (e.audioTime > heard) break;
      // Seen already: there at the last call and heard by then, where "then" is the furthest the heard moment has been
      // since the event arrived.
      if (e.seq > cursor.seq || e.audioTime > (low !== undefined && e.seq > lowSeq ? low : cursor.time)) visit(e);
    }
    if (heard >= cursor.time) { cursor.time = heard; cursor.low = undefined; }
    else if (low === undefined) { cursor.low = heard; cursor.lowSeq = cursor.seq; }
    else if (heard > low) cursor.low = heard;
    // Only arrivals already heard are settled; future ones stay visible through their time.
    cursor.seq = this.seq;
  }

  reset(): void {
    this.head = this.count = this.seq = this.evicted = 0;
    this.epoch++;
  }
}
