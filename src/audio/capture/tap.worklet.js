// Stereo is preserved for musical analysis. Graphical downmix happens in the host.
//
// Two outputs: blocks of BLOCK frames posted to the main thread (graphics ring),
// and every frame streamed to the analysis worker, either through a shared
// PcmRing (src/audio/features/PcmRing.ts: this writer mirrors its layout) or,
// without cross-origin isolation, as transferred blocks on a MessagePort.
// The analysis stream is continuous on the context's sample clock: render
// quanta that were skipped are written as silence (counted in the ring header).
const BLOCK = 1024;
/** Frames between two wake-ups of the analysis worker (2 hops of 256). */
const NOTIFY = 512;
const HEADER = 16, WRITTEN = 0, SEQUENCE = 1, FILLED = 2;

class SampleTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK * 2);
    this.filled = 0;
    this.state = null;
    this.data = null;
    this.mask = 0;
    this.analysis = null;
    this.analysisBlock = new Float32Array(BLOCK * 2);
    this.analysisFilled = 0;
    this.sinceNotify = 0;
    this.next = -1;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message || message.type !== 'analysis') return;
      if (message.ring) {
        this.state = new Int32Array(message.ring, 0, 4);
        this.data = new Float32Array(message.ring, HEADER);
        this.mask = this.data.length / 2 - 1;
      }
      this.analysis = message.port || null;
      this.next = -1;
    };
  }

  /** One stereo frame to the analysis. */
  feed(left, right, w) {
    if (this.data) {
      const at = (w & this.mask) * 2;
      this.data[at] = left;
      this.data[at + 1] = right;
    } else if (this.analysis) {
      this.analysisBlock[this.analysisFilled * 2] = left;
      this.analysisBlock[this.analysisFilled * 2 + 1] = right;
      if (++this.analysisFilled === BLOCK) {
        this.analysis.postMessage(this.analysisBlock, [this.analysisBlock.buffer]);
        this.analysisBlock = new Float32Array(BLOCK * 2);
        this.analysisFilled = 0;
      }
    }
  }

  publish(w, frames) {
    if (!this.state) return;
    Atomics.store(this.state, WRITTEN, w);
    this.sinceNotify += frames;
    if (this.sinceNotify >= NOTIFY) {
      this.sinceNotify = 0;
      Atomics.add(this.state, SEQUENCE, 1);
      Atomics.notify(this.state, SEQUENCE);
    }
  }

  process(inputs) {
    const channels = inputs[0];
    const live = this.data || this.analysis;
    let w = this.state ? Atomics.load(this.state, WRITTEN) : 0;
    if (live && this.next >= 0 && currentFrame > this.next) {
      // Skipped render quanta: silence keeps the analysis clock equal to the context's.
      const gap = Math.min(currentFrame - this.next, sampleRate);
      for (let i = 0; i < gap; i++, w = (w + 1) | 0) this.feed(0, 0, w);
      if (this.state) Atomics.add(this.state, FILLED, gap);
      this.publish(w, gap);
    }
    if (channels && channels[0]) {
      const left = channels[0], right = channels[1] || left;
      this.next = currentFrame + left.length;
      for (let i = 0; i < left.length; i++) {
        this.block[this.filled * 2] = left[i];
        this.block[this.filled * 2 + 1] = right[i];
        if (++this.filled === BLOCK) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(BLOCK * 2); this.filled = 0;
        }
        if (live) { this.feed(left[i], right[i], w); w = (w + 1) | 0; }
      }
      if (live) this.publish(w, left.length);
    }
    return true;
  }
}
registerProcessor('euforia-audio-experience-sample-tap', SampleTap);
