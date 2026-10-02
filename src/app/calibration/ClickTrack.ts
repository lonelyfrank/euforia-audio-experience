/** Click rate during calibration (BPM) and how far ahead clicks are scheduled (s). */
const BPM = 120;
const AHEAD = 0.3;

/**
 * Plays a click track through the system output with Web Audio and reports
 * when each click reaches the output, on the host clock
 * (`AudioContext.getOutputTimestamp`). Used by the sync calibration: the
 * loopback capture hears the clicks like any other sound.
 */
export class ClickTrack {
  private context: AudioContext | null = null;
  private next = 0;
  private timer = 0;

  constructor(private readonly onClick: (hostSeconds: number) => void) {}

  get running(): boolean {
    return this.context !== null;
  }

  /** The browser's estimate of its output latency (s): device buffer to the speakers; 0 if unknown. */
  get outputLatency(): number {
    const context = this.context;
    return context ? context.outputLatency || context.baseLatency || 0 : 0;
  }

  async start(): Promise<void> {
    if (this.context) return;
    const context = new AudioContext({ latencyHint: 'interactive' });
    await context.resume();
    this.context = context;
    this.next = context.currentTime + 0.2;
    this.timer = window.setInterval(() => this.schedule(), 50);
    this.schedule();
  }

  async stop(): Promise<void> {
    window.clearInterval(this.timer);
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') await context.close();
  }

  private schedule(): void {
    const context = this.context;
    if (!context) return;
    const stamp = context.getOutputTimestamp();
    while (this.next < context.currentTime + AHEAD) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.frequency.value = 1500;
      gain.gain.setValueAtTime(0.6, this.next);
      gain.gain.exponentialRampToValueAtTime(0.001, this.next + 0.012);
      osc.connect(gain).connect(context.destination);
      osc.start(this.next);
      osc.stop(this.next + 0.015);
      if (stamp.contextTime !== undefined && stamp.performanceTime !== undefined) {
        this.onClick((stamp.performanceTime + (this.next - stamp.contextTime) * 1000) / 1000);
      }
      this.next += 60 / BPM;
    }
  }
}
