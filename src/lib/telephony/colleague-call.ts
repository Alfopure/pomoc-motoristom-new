/**
 * Who a colleague call may ring, shared by the server (authoritative) and the
 * Ústredňa team strip (explains a disabled button before the click).
 *
 * Owner decision, 28 Sep 2026: an available colleague and a colleague on
 * pause can be called. A paused colleague stays paused for the whole call, so
 * no customer offer reaches them and nothing has to be restored afterwards.
 */

export type ColleagueCallBlock = "busy" | "wrap_up" | "offline" | "no_phone" | "personal_mobile" | "capacity";

export const COLLEAGUE_CALL_MESSAGES: Record<ColleagueCallBlock, string> = {
  busy: "Kolega práve telefonuje.",
  wrap_up: "Kolega práve dokončuje hovor. Skúste to o chvíľu.",
  offline: "Kolega je odhlásený z telefónie.",
  no_phone: "Kolega nemá zapnutý telefón v aplikácii.",
  personal_mobile: "Kolega prijíma hovory na osobnom mobile. Interný hovor mu zatiaľ nie je možné spojiť.",
  capacity: "Ústredňa je práve vyťažená a zákazníci majú prednosť. Skúste to o chvíľu.",
};

/** Presence part of the rule; `status` is the effective presence status. */
export function colleaguePresenceBlock(input: { status: string | null | undefined; inCall: boolean }): "busy" | "wrap_up" | "offline" | null {
  if (input.inCall) return "busy";
  switch (input.status) {
    case "available":
    case "paused":
      return null;
    case "ringing":
    case "on_call":
      return "busy";
    case "after_call_work":
      return "wrap_up";
    default:
      return "offline";
  }
}
