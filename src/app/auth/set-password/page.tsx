import { SetPasswordForm } from "@/components/auth/SetPasswordForm";

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ module?: string }> }) {
  return <SetPasswordForm towing={(await searchParams).module === "towing"} />;
}
