import type { Metadata } from "next";
import { connection } from "next/server";

import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { WallboardScreen } from "@/components/dispatch/WallboardScreen";
import { getDefaultMotoristAuthState } from "@/server/api-auth";

/**
 * The wall display (design §4 Phase 4: `src/app/wallboard/page.tsx`, session,
 * senior+).
 *
 * It is a route of its own rather than a view inside the console for one
 * practical reason: the screen it runs on is a television in the dispatch room
 * with no keyboard. It has to be reachable by URL, survive a reload, and carry
 * none of the console's chrome, dialogs or hotkeys.
 *
 * The role gate is here *and* on `/api/telephony/stats`. This one only decides
 * what the browser renders; the endpoint is what actually protects the numbers,
 * because a page is a hint and an API is a boundary.
 */

export const metadata: Metadata = { title: "Wallboard" };

const WALLBOARD_ROLES = ["senior_dispatcher", "manager", "admin"] as const;

export default async function WallboardPage() {
  await connection();
  const authState = await getDefaultMotoristAuthState([...WALLBOARD_ROLES]);

  if (!authState.authorized) {
    return <MotoristLogin message={authState.message} />;
  }

  return <WallboardScreen />;
}
