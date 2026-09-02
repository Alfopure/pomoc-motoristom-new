const BROWSER_SIP_INVITE_ERROR = "Hovor sa v telefónnej ústredni nepodarilo začať. Skús ho znova.";

export async function placeBrowserSipInvite(
  invite: () => Promise<void>,
  onRejected: () => void,
) {
  try {
    await invite();
  } catch {
    onRejected();
    throw new Error(BROWSER_SIP_INVITE_ERROR);
  }
}
