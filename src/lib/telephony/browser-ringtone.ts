"use client";

const RING_CYCLE_SECONDS = 2.4;
const RING_BURSTS: ReadonlyArray<readonly [startSeconds: number, endSeconds: number]> = [
  [0, 0.38],
  [0.56, 0.94],
];
const RING_FREQUENCY_HZ = 425;
const RING_VOLUME = 0.09;

/**
 * A Web Audio ringtone that is unlocked by a normal user gesture and can then
 * keep playing when the dispatch tab is in the background. The loop is stored
 * in one AudioBuffer, so it does not depend on throttled window timers.
 */
export class BrowserIncomingRingtone {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  async unlock() {
    const context = this.getOrCreateContext();
    if (!context) return false;
    if (context.state === "suspended") {
      await context.resume().catch(() => undefined);
    }
    return context.state === "running";
  }

  async start() {
    if (this.source) return true;
    const context = this.context;
    if (!context || context.state === "closed") return false;
    if (context.state === "suspended") {
      await context.resume().catch(() => undefined);
    }
    if (context.state !== "running" || this.source) return Boolean(this.source);

    const source = context.createBufferSource();
    source.buffer = this.buffer ?? (this.buffer = createRingtoneBuffer(context));
    source.loop = true;
    source.connect(context.destination);
    source.start();
    this.source = source;
    return true;
  }

  stop() {
    const source = this.source;
    this.source = null;
    if (!source) return;
    try {
      source.stop();
    } catch {
      // The call state can settle twice (SIP event + provider refresh).
    }
    source.disconnect();
  }

  dispose() {
    this.stop();
    const context = this.context;
    this.context = null;
    this.buffer = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }

  private getOrCreateContext() {
    if (this.context && this.context.state !== "closed") return this.context;
    if (typeof AudioContext === "undefined") return null;
    try {
      this.context = new AudioContext();
      return this.context;
    } catch {
      return null;
    }
  }
}

function createRingtoneBuffer(context: AudioContext) {
  const frameCount = Math.ceil(context.sampleRate * RING_CYCLE_SECONDS);
  const buffer = context.createBuffer(1, frameCount, context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const seconds = frame / context.sampleRate;
    const burst = RING_BURSTS.find(([start, end]) => seconds >= start && seconds < end);
    if (!burst) continue;
    const [start, end] = burst;
    const elapsed = seconds - start;
    const remaining = end - seconds;
    const envelope = Math.min(1, elapsed / 0.02, remaining / 0.03);
    channel[frame] = Math.sin(2 * Math.PI * RING_FREQUENCY_HZ * seconds) * RING_VOLUME * envelope;
  }
  return buffer;
}
