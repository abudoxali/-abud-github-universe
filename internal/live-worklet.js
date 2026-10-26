/* Microphone capture for the live call: float samples at the device rate -> 16 kHz mono 16-bit PCM in 40 ms frames. */
class AbudLiveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.pos = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Int16Array(640);
    this.fill = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i];
      this.count++;
      this.pos += 1;
      if (this.pos >= this.step) {
        this.pos -= this.step;
        const mean = this.sum / this.count;
        this.sum = 0;
        this.count = 0;
        const clipped = Math.max(-1, Math.min(1, mean));
        this.frame[this.fill++] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
        if (this.fill === this.frame.length) {
          const out = this.frame.slice();
          this.port.postMessage(out.buffer, [out.buffer]);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("abud-live-capture", AbudLiveCapture);
