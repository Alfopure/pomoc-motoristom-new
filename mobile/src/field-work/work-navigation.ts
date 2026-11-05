/** Every way out of an edited work card uses the same explicit discard decision. */
export function requestWorkNavigation(dirty: boolean, commit: () => void,
  confirm: (discard: () => void, keep: () => void) => void) {
  if (!dirty) { commit(); return; }
  let pending = true;
  confirm(() => { if (pending) { pending = false; commit(); } }, () => { pending = false; });
}
