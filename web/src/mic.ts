// Captures the microphone as 16 kHz PCM chunks for server-side speech-to-text.

export interface Mic {
  stop: () => void;
}

export async function startMic(onChunk: (pcm: ArrayBuffer) => void): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("/pcm-worklet.js");
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-downsampler");
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onChunk(e.data);
  source.connect(node);
  // The node outputs silence; connecting it keeps the graph pulling audio in every browser.
  node.connect(ctx.destination);
  return {
    stop() {
      node.disconnect();
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void ctx.close();
    },
  };
}

/** Rough 0-1 loudness of a PCM chunk, for a level meter. */
export function level(pcm: ArrayBuffer): number {
  const samples = new Int16Array(pcm);
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) / 8000);
}
