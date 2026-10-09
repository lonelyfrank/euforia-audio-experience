import { TARGET_FPS } from '../../renderer/quality';
import { RollingStatistics } from '../metrics/RollingStatistics';

/** A frame this many times the target interval is a visible hitch. */
const JANK = 1.5;

/**
 * What only shows frame by frame: how regularly the picture is timed, not how fast it is drawn.
 *
 * - the frame pacing itself (frames over 33, 50 and 100 ms, the share of hitches);
 * - the heard clock: each frame the moment being shown should advance by exactly the frame
 *   interval; the difference is motion that stutters although the frame arrived on time;
 * - the ingestion: hop frames decoded in one rendered frame (a burst after a stall).
 *
 * Counters since the last reset; statistics over the last 300 frames. Fixed memory, no allocation per frame.
 */
export class PresentationProbe {
  /** |advance of the heard moment − frame interval|, ms. */
  readonly heardError = new RollingStatistics(300);
  readonly hops = new RollingStatistics(300);
  frames = 0;
  over33 = 0;
  over50 = 0;
  over100 = 0;
  janks = 0;
  maxHops = 0;
  /** Largest step of the heard clock against its frame, ms, since the last reset. */
  maxHeardError = 0;
  private lastHeard = NaN;
  private lastDecoded = -1;

  /** One rendered frame: its interval (ms), the heard moment it shows (s, NaN while the clock is not ready), hop frames decoded so far. */
  frame(frameMs: number, heardTime: number, decoded: number): void {
    this.frames++;
    if (frameMs > 100 / 3) this.over33++;
    if (frameMs > 50) this.over50++;
    if (frameMs > 100) this.over100++;
    if (frameMs > (1000 / TARGET_FPS) * JANK) this.janks++;
    if (Number.isFinite(heardTime) && Number.isFinite(this.lastHeard)) {
      const error = Math.abs((heardTime - this.lastHeard) * 1000 - frameMs);
      this.heardError.push(error);
      if (error > this.maxHeardError) this.maxHeardError = error;
    }
    this.lastHeard = heardTime;
    if (this.lastDecoded >= 0 && decoded >= this.lastDecoded) {
      const hops = decoded - this.lastDecoded;
      this.hops.push(hops);
      if (hops > this.maxHops) this.maxHops = hops;
    }
    this.lastDecoded = decoded;
  }

  reset(): void {
    this.heardError.reset();
    this.hops.reset();
    this.frames = this.over33 = this.over50 = this.over100 = this.janks = this.maxHops = this.maxHeardError = 0;
    this.lastHeard = NaN;
    this.lastDecoded = -1;
  }
}
