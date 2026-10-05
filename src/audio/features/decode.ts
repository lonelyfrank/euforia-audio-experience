import { BEAT_FIELDS, CLOCK_FIELDS, FRAME_FIELDS, ONSET_FIELDS, RECORD, SECTION_FIELDS, TAG } from './layout';

/*
 * Decoding of the analysis event stream (see native/analysis/src/wire.rs):
 * records of f64 values, each starting with a tag. The TypeScript shapes are
 * derived from the generated layout, so a field added in Rust appears here
 * without hand-written mirrors. Everything is decoded into reused objects.
 */

type Shape<F> = { -readonly [K in keyof F]: F[K] extends readonly [number, 1] ? number : Float64Array };

/** One hop of measurements (capture clock in `sample` / `time`); see FeatureFrame in Rust for each field. */
export type AnalysisFrame = Shape<typeof FRAME_FIELDS>;
export type OnsetEvent = Shape<typeof ONSET_FIELDS>;
export type BeatEvent = Shape<typeof BEAT_FIELDS>;
/** A section change (kind: 0 intro, 1 build, 2 drop, 3 break, 4 outro), stamped at its downbeat. */
export type SectionEvent = Shape<typeof SECTION_FIELDS>;
export const SECTION_NAMES = ['intro', 'build', 'drop', 'break', 'outro'] as const;
/** Sent by native hosts with each batch: capture clock (`sample`) and the age (s) of its newest sample. */
export type ClockRecord = Shape<typeof CLOCK_FIELDS>;

function blank<F extends Record<string, readonly [number, number]>>(fields: F): Shape<F> {
  const out: Record<string, number | Float64Array> = {};
  for (const [name, [, length]] of Object.entries(fields)) out[name] = length === 1 ? 0 : new Float64Array(length);
  return out as Shape<F>;
}

function read<F extends Record<string, readonly [number, number]>>(fields: F, target: Shape<F>, data: Float64Array, at: number): void {
  const out = target as Record<string, number | Float64Array>;
  for (const name in fields) {
    const [offset, length] = fields[name];
    if (length === 1) out[name] = data[at + offset];
    else {
      const values = out[name] as Float64Array;
      for (let i = 0; i < length; i++) values[i] = data[at + offset + i];
    }
  }
}

/** A fixed pool of reused events; `count` are valid after each decode. */
export class EventList<T> {
  count = 0;
  readonly items: T[];

  constructor(capacity: number, make: () => T) {
    this.items = Array.from({ length: capacity }, make);
  }

  /** Next slot to fill, or null when full (the extra events are dropped). */
  next(): T | null {
    return this.count < this.items.length ? this.items[this.count++] : null;
  }
}

export const newFrame = (): AnalysisFrame => {
  const frame = blank(FRAME_FIELDS);
  frame.key = -1;
  return frame;
};

/** Copy a measurement into owned storage, retaining every typed-array identity. */
export function copyFrame(to: AnalysisFrame, from: AnalysisFrame): void {
  for (const key in FRAME_FIELDS) {
    const k = key as keyof AnalysisFrame;
    const value = from[k];
    if (typeof value === 'number') (to[k] as number) = value;
    else (to[k] as Float64Array).set(value);
  }
}

/**
 * Turns batches of records into the latest frame and the onsets/beats since
 * the previous batch. Allocation-free after construction.
 */
export class AnalysisDecoder {
  readonly frame = newFrame();
  /** Synchronous consumers, called in stream order: the borrowed record is valid only during the call. */
  onFrame?: (frame: AnalysisFrame) => void;
  onOnset?: (onset: OnsetEvent) => void;
  onBeat?: (beat: BeatEvent) => void;
  onSection?: (section: SectionEvent) => void;
  /** Where events beyond a full per-frame list are decoded for the consumers. */
  private readonly spareOnset = blank(ONSET_FIELDS);
  private readonly spareBeat = blank(BEAT_FIELDS);
  private readonly spareSection = blank(SECTION_FIELDS);
  readonly onsets = new EventList(64, () => blank(ONSET_FIELDS));
  readonly beats = new EventList(32, () => blank(BEAT_FIELDS));
  readonly sections = new EventList(8, () => blank(SECTION_FIELDS));
  /** The latest clock record of the batch (`clocked` tells whether one arrived). */
  readonly clock = blank(CLOCK_FIELDS);
  clocked = false;
  /** Frames decoded in total (to tell whether anything arrived). */
  frames = 0;

  /** Starts a new batch: the previous batch's onsets and beats are cleared. */
  begin(): void {
    this.onsets.count = 0;
    this.beats.count = 0;
    this.sections.count = 0;
    this.clocked = false;
  }

  /** Decodes `length` values of `data` (whole records). */
  decode(data: Float64Array, length = data.length): void {
    length = Math.min(length, data.length);
    let at = 0;
    while (at < length) {
      const tag = data[at];
      // Ignore truncated or unknown records before touching the reusable state.
      const size = tag === TAG.frame ? RECORD.frame : tag === TAG.onset ? RECORD.onset :
        tag === TAG.beat ? RECORD.beat : tag === TAG.section ? RECORD.section : tag === TAG.clock ? RECORD.clock : 0;
      if (size === 0 || at + size > length) return;
      if (tag === TAG.frame) {
        read(FRAME_FIELDS, this.frame, data, at);
        this.frames++;
        this.onFrame?.(this.frame);
        at += RECORD.frame;
      } else if (tag === TAG.onset) {
        const slot = this.onsets.next() ?? this.spareOnset;
        read(ONSET_FIELDS, slot, data, at);
        this.onOnset?.(slot);
        at += RECORD.onset;
      } else if (tag === TAG.beat) {
        const slot = this.beats.next() ?? this.spareBeat;
        read(BEAT_FIELDS, slot, data, at);
        this.onBeat?.(slot);
        at += RECORD.beat;
      } else if (tag === TAG.section) {
        const slot = this.sections.next() ?? this.spareSection;
        read(SECTION_FIELDS, slot, data, at);
        this.onSection?.(slot);
        at += RECORD.section;
      } else if (tag === TAG.clock) {
        read(CLOCK_FIELDS, this.clock, data, at);
        this.clocked = true;
        at += RECORD.clock;
      } else {
        // Unknown record: the stream is out of sync; drop the rest of the batch.
        return;
      }
    }
  }

  reset(): void {
    this.begin();
    Object.assign(this.frame, newFrame());
    this.frames = 0;
  }
}
