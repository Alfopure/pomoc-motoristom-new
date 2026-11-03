type ClipboardAdapters = {
  platform: string;
  native: () => Promise<{ setStringAsync: (value: string) => Promise<boolean> }>;
  web: (value: string) => Promise<void>;
};
/** Check the captured screen/value scope before and after each asynchronous boundary. */
export async function writeClipboard(value: string, current: () => boolean, adapters: ClipboardAdapters): Promise<boolean> {
  if (!current()) return false;
  if (adapters.platform === "web") {
    // Invoke synchronously in the gesture, before any import or await.
    await adapters.web(value);
  } else {
    const native = await adapters.native();
    if (!current()) return false;
    if (!await native.setStringAsync(value)) throw new Error("Clipboard rejected");
  }
  return current();
}
