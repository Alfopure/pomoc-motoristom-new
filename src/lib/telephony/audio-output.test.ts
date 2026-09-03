import { describe, expect, it, vi } from "vitest";

import {
  applyAudioOutput,
  audioOutputMissing,
  audioOutputOptions,
  audioOutputSupported,
  listAudioOutputs,
  readStoredAudioOutput,
  selectedAudioOutput,
  storeAudioOutput,
  AUDIO_OUTPUT_STORAGE_KEY,
} from "./audio-output";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  };
}

describe("audioOutputOptions", () => {
  it("keeps speakers only, in order, without duplicates", () => {
    expect(
      audioOutputOptions([
        { deviceId: "mic-1", kind: "audioinput", label: "Mikrofón" },
        { deviceId: "spk-1", kind: "audiooutput", label: "Headset" },
        { deviceId: "spk-1", kind: "audiooutput", label: "Headset" },
        { deviceId: "cam-1", kind: "videoinput", label: "Kamera" },
        { deviceId: "spk-2", kind: "audiooutput", label: "Reproduktory" },
      ]),
    ).toEqual([
      { deviceId: "spk-1", label: "Headset" },
      { deviceId: "spk-2", label: "Reproduktory" },
    ]);
  });

  it("labels the system default and numbers the unnamed devices before permission is granted", () => {
    expect(
      audioOutputOptions([
        { deviceId: "default", kind: "audiooutput", label: "" },
        { deviceId: "spk-9", kind: "audiooutput" },
      ]),
    ).toEqual([
      { deviceId: "default", label: "Predvolené zariadenie systému" },
      { deviceId: "spk-9", label: "Zvukový výstup 2" },
    ]);
  });
});

describe("selectedAudioOutput", () => {
  const options = [{ deviceId: "spk-1", label: "Headset" }];

  it("keeps a stored device that is still plugged in", () => {
    expect(selectedAudioOutput(options, "spk-1")).toBe("spk-1");
    expect(audioOutputMissing(options, "spk-1")).toBe(false);
  });

  it("falls back to the system default when the headset is gone", () => {
    expect(selectedAudioOutput(options, "spk-unplugged")).toBe("");
    expect(audioOutputMissing(options, "spk-unplugged")).toBe(true);
  });

  it("treats no stored choice as the system default", () => {
    expect(selectedAudioOutput(options, null)).toBe("");
    expect(audioOutputMissing(options, null)).toBe(false);
  });
});

describe("storage", () => {
  it("round-trips the device id and clears it on null", () => {
    const storage = memoryStorage();
    storeAudioOutput("spk-1", storage);
    expect(storage.map.get(AUDIO_OUTPUT_STORAGE_KEY)).toBe("spk-1");
    expect(readStoredAudioOutput(storage)).toBe("spk-1");
    storeAudioOutput(null, storage);
    expect(readStoredAudioOutput(storage)).toBeNull();
  });

  it("survives a storage that throws (private window)", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredAudioOutput(hostile)).toBeNull();
    expect(() => storeAudioOutput("spk-1", hostile)).not.toThrow();
  });

  it("reads an empty value as no choice", () => {
    expect(readStoredAudioOutput(memoryStorage({ [AUDIO_OUTPUT_STORAGE_KEY]: "   " }))).toBeNull();
  });
});

describe("audioOutputSupported", () => {
  it("needs both setSinkId and mediaDevices", () => {
    expect(audioOutputSupported({ HTMLMediaElement: { prototype: { setSinkId: () => undefined } }, navigator: { mediaDevices: {} } })).toBe(true);
    expect(audioOutputSupported({ HTMLMediaElement: { prototype: {} }, navigator: { mediaDevices: {} } })).toBe(false);
    expect(audioOutputSupported({ HTMLMediaElement: { prototype: { setSinkId: () => undefined } }, navigator: {} })).toBe(false);
    expect(audioOutputSupported({})).toBe(false);
  });
});

describe("applyAudioOutput", () => {
  it("calls setSinkId with the chosen device", async () => {
    const setSinkId = vi.fn(async () => undefined);
    const element = { setSinkId } as unknown as HTMLMediaElement;
    await expect(applyAudioOutput(element, "spk-1")).resolves.toBe(true);
    expect(setSinkId).toHaveBeenCalledWith("spk-1");
  });

  it("sends the empty sink id for the system default", async () => {
    const setSinkId = vi.fn(async () => undefined);
    await applyAudioOutput({ setSinkId } as unknown as HTMLMediaElement, null);
    expect(setSinkId).toHaveBeenCalledWith("");
  });

  it("never throws when the browser refuses the sink", async () => {
    const element = {
      setSinkId: async () => {
        throw new Error("NotAllowedError");
      },
    } as unknown as HTMLMediaElement;
    await expect(applyAudioOutput(element, "spk-1")).resolves.toBe(false);
  });

  it("reports unsupported when the element has no setSinkId", async () => {
    await expect(applyAudioOutput({} as HTMLMediaElement, "spk-1")).resolves.toBe(false);
    await expect(applyAudioOutput(null, "spk-1")).resolves.toBe(false);
  });
});

describe("listAudioOutputs", () => {
  it("filters what the browser enumerates", async () => {
    const mediaDevices = {
      enumerateDevices: async () => [
        { deviceId: "spk-1", kind: "audiooutput", label: "Headset" },
        { deviceId: "mic-1", kind: "audioinput", label: "Mikrofón" },
      ],
    } as unknown as MediaDevices;
    await expect(listAudioOutputs(mediaDevices)).resolves.toEqual([{ deviceId: "spk-1", label: "Headset" }]);
  });

  it("is empty without a mediaDevices implementation", async () => {
    await expect(listAudioOutputs(null)).resolves.toEqual([]);
  });
});
