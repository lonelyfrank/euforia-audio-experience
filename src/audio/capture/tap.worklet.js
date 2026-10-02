// AudioWorklet that forwards the input's first channel to the main thread in
// blocks of BLOCK samples (≈ 21 ms at 48 kHz), so every sample reaches the
// analysis, not just the newest window. Plain JS: worklets load as-is.
const BLOCK = 1024;

class SampleTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      let from = 0;
      while (from < channel.length) {
        const n = Math.min(channel.length - from, BLOCK - this.filled);
        this.block.set(channel.subarray(from, from + n), this.filled);
        this.filled += n;
        from += n;
        if (this.filled === BLOCK) {
          // Transfer the full block and start a new one.
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(BLOCK);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('halo-sample-tap', SampleTap);
