// Downsamples mic audio to 16 kHz mono 16-bit PCM and posts ~50 ms chunks.
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 800;

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.phase = 0;
    this.acc = 0;
    this.accCount = 0;
    this.buf = new Int16Array(CHUNK_SAMPLES);
    this.len = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      // Averaging each output sample's window doubles as a cheap low-pass filter.
      this.acc += input[i];
      this.accCount++;
      this.phase += 1;
      if (this.phase < this.ratio) continue;
      this.phase -= this.ratio;
      const v = Math.max(-1, Math.min(1, this.acc / this.accCount));
      this.buf[this.len++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.acc = 0;
      this.accCount = 0;
      if (this.len === CHUNK_SAMPLES) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(CHUNK_SAMPLES);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-downsampler", PcmDownsampler);
