const approvedUnloadEvents = new WeakSet<Event>();
let approveNextUnload: ((event: BeforeUnloadEvent) => void) | null = null;

export function protectDraftBeforeUnload(event: BeforeUnloadEvent) {
  // Window's at-target listeners can run in registration order even with
  // capture:true. The first form guard must also be able to consume approval.
  approveNextUnload?.(event);
  if (!approvedUnloadEvents.has(event)) event.preventDefault();
}

/** The app's save/discard dialog already approved this one document navigation. */
export function navigateAfterDraftApproval(navigate: () => void) {
  const approveUnload = (event: BeforeUnloadEvent) => {
    if (approveNextUnload !== approveUnload) return;
    approvedUnloadEvents.add(event);
    cleanup();
  };
  const cleanup = () => {
    window.removeEventListener("beforeunload", approveUnload, true);
    window.clearTimeout(timer);
    if (approveNextUnload === approveUnload) approveNextUnload = null;
  };
  // Approval belongs to one event only. The additional listener consumes it
  // even when no dirty form is mounted; timeout covers a blocked navigation.
  approveNextUnload = approveUnload;
  window.addEventListener("beforeunload", approveUnload, { capture: true, once: true });
  const timer = window.setTimeout(cleanup, 1_000);
  try {
    navigate();
  } catch (error) {
    cleanup();
    throw error;
  }
}
