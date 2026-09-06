/** Shared by the live overview and the server's locked pickup transition. */
export function canPickUpCall(call: {
  state: string;
  direction: string;
  answered: boolean;
  operatorProfileId: string | null;
}): boolean {
  if (call.state === "waiting" || call.state === "parked") return true;
  return call.state === "ringing" && call.direction === "inbound" && !call.answered && !call.operatorProfileId;
}
