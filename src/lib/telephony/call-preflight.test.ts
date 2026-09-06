import { afterEach, describe, expect, it, vi } from "vitest";
import { browserCallStartError, checkMicrophone } from "./call-preflight";
import type { WebphoneSnapshot } from "./telnyx-webphone";

afterEach(() => vi.useRealTimers());

const registered = { status: "registered", call: null, pendingOperatorLegs: 0 } as WebphoneSnapshot;
function mediaStream() {
  const audio = { readyState: "live", stop: vi.fn() };
  const extra = { stop: vi.fn() };
  return { audio, extra, stream: { getAudioTracks: () => [audio], getTracks: () => [audio, extra] } as unknown as MediaStream };
}

describe("browser call preflight", () => {
  it("requires a registered, unoccupied browser phone", () => {
    expect(browserCallStartError(registered)).toBeNull();
    expect(browserCallStartError(undefined)).toMatch(/pripojený/);
    expect(browserCallStartError({ ...registered, status: "reconnecting" })).toMatch(/pripojený/);
    expect(browserCallStartError({ ...registered, pendingOperatorLegs: 1 })).toMatch(/dokončite/);
    expect(browserCallStartError({ ...registered, call: { ringing: true } as WebphoneSnapshot["call"] })).toMatch(/dokončite/);
  });

  it("checks only audio and releases all acquired tracks immediately", async () => {
    const { stream, audio, extra } = mediaStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    await checkMicrophone({ signal: new AbortController().signal, mediaDevices: { getUserMedia } });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(extra.stop).toHaveBeenCalledOnce();
  });

  it.each([
    ["NotAllowedError", /zablokovaný/], ["NotFoundError", /nenašiel/], ["NotReadableError", /iný hovor/],
  ])("explains %s without exposing browser internals", async (name, message) => {
    const getUserMedia = vi.fn().mockRejectedValue({ name });
    await expect(checkMicrophone({ signal: new AbortController().signal, mediaDevices: { getUserMedia } })).rejects.toThrow(message);
  });

  it("rejects streams without a live microphone and still stops tracks", async () => {
    const { stream, audio } = mediaStream();
    audio.readyState = "ended";
    await expect(checkMicrophone({ signal: new AbortController().signal, mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } })).rejects.toThrow(/neposkytuje/);
    expect(audio.stop).toHaveBeenCalledOnce();
  });

  it("times out ignored permissions and releases a later grant without succeeding", async () => {
    vi.useFakeTimers();
    let grant!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { grant = resolve; }));
    const check = checkMicrophone({ signal: new AbortController().signal, mediaDevices: { getUserMedia }, timeoutMs: 100 });
    const result = expect(check).rejects.toThrow(/nebolo potvrdené/);
    await vi.advanceTimersByTimeAsync(100);
    await result;
    const { stream, audio } = mediaStream();
    grant(stream);
    await Promise.resolve();
    expect(audio.stop).toHaveBeenCalledOnce();
  });

  it("cancels on unmount and stops audio if permission resolves afterwards", async () => {
    let grant!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { grant = resolve; }));
    const controller = new AbortController();
    const check = checkMicrophone({ signal: controller.signal, mediaDevices: { getUserMedia } });
    controller.abort();
    await expect(check).rejects.toThrow(/zrušená/);
    const { stream, audio } = mediaStream();
    grant(stream);
    await Promise.resolve();
    expect(audio.stop).toHaveBeenCalledOnce();
  });
});
