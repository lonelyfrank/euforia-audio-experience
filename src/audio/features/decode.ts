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
/** Genre families of `AnalysisFrame.genre` (prior weights). */
export const GENRE_NAMES = ['four-on-the-floor', 'drum-and-bass', 'hip-hop', 'band', 'ambient', 'acoustic'] as const;
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
    else (out[name] as Float64Array).set(data.subarray(at + offset, at + offset + length));
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

/**
 * Turns batches of records into the latest frame and the onsets/beats since
 * the previous batch. Allocation-free after construction.
 */
export class AnalysisDecoder {
  readonly frame = newFrame();
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
    let at = 0;
    while (at < length) {
      const tag = data[at];
      if (tag === TAG.frame) {
        read(FRAME_FIELDS, this.frame, data, at);
        this.frames++;
        at += RECORD.frame;
      } else if (tag === TAG.onset) {
        const slot = this.onsets.next();
        if (slot) read(ONSET_FIELDS, slot, data, at);
        at += RECORD.onset;
      } else if (tag === TAG.beat) {
        const slot = this.beats.next();
        if (slot) read(BEAT_FIELDS, slot, data, at);
        at += RECORD.beat;
      } else if (tag === TAG.section) {
        const slot = this.sections.next();
        if (slot) read(SECTION_FIELDS, slot, data, at);
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
