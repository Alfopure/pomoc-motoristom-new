import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { GuideArticle } from "@/components/guide";
import { guideChapters } from "@/content/guide/chapters";
import { getDefaultMotoristAuthState } from "@/server/api-auth";
import { LoginGuide } from "./public-login-guide";

type Props = { params: Promise<{ slug: string }> };
export const metadata: Metadata = { title: "Návod k dispečingu", robots: { index: false, follow: false } };

export default async function GuideChapterPage({ params }: Props) {
  const { slug } = await params;
  const chapter = guideChapters.find(item => item.slug === slug);
  if (!chapter) notFound();
  await connection();
  const auth = await getDefaultMotoristAuthState();
  // Public account help stays small. Signed-in readers retain guide navigation
  // instead of being sent to the dispatch console in a second phone window.
  if (!auth.authorized && slug === "prihlasenie") return <LoginGuide chapter={chapter} />;
  if (!auth.authorized) return <MotoristLogin message="Po prihlásení sa otvorí vybraný postup návodu." returnTo={`/navod/${chapter.slug}`} />;
  return <GuideArticle chapter={chapter} />;
}
