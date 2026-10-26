import { SetPasswordForm } from "@/components/auth/SetPasswordForm";

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ module?: string; invitation?: string }> }) {
  const params = await searchParams;
  return <SetPasswordForm towing={params.module === "towing"} partner={params.module === "partner"} invitationId={params.invitation} />;
}
