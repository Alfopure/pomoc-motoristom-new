import type { Metadata } from "next";
import { connection } from "next/server";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { GuideHome } from "@/components/guide";
import { getDefaultMotoristAuthState } from "@/server/api-auth";

export const metadata: Metadata = { title: "Návod", robots: { index: false, follow: false } };

export default async function GuidePage() {
  await connection();
  const auth = await getDefaultMotoristAuthState();
  if (!auth.authorized) return <MotoristLogin message="Prihláste sa a otvorte návod k dispečingu." returnTo="/navod" />;
  return <GuideHome />;
}
