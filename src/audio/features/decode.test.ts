import { describe, expect, it } from 'vitest';
import { AnalysisDecoder } from './decode';
import { FRAME_FIELDS, RECORD, TAG } from './layout';

describe('AnalysisDecoder', () => {
  it('ignores incomplete records without corrupting the last good frame', () => {
    const decoder = new AnalysisDecoder();
    const frame = new Float64Array(RECORD.frame);
    frame[0] = TAG.frame;
    frame[FRAME_FIELDS.time[0]] = 12;
    decoder.decode(frame);
    decoder.decode(Float64Array.of(TAG.frame, 99));
    decoder.decode(frame, RECORD.frame - 1);
    decoder.decode(Float64Array.of(TAG.onset, 99), 1000);
    expect(decoder.frames).toBe(1);
    expect(decoder.frame.time).toBe(12);
    expect(decoder.onsets.count).toBe(0);
  });

  it('reuses arrays and stops at an unknown record', () => {
    const decoder = new AnalysisDecoder();
    const bands = decoder.frame.bandDb;
    const frame = new Float64Array(RECORD.frame + 1);
    frame[0] = TAG.frame;
    frame[FRAME_FIELDS.bandDb[0]] = -24;
    frame[RECORD.frame] = -1;
    decoder.decode(frame);
    expect(decoder.frame.bandDb).toBe(bands);
    expect(bands[0]).toBe(-24);
    expect(decoder.frames).toBe(1);
  });
});
