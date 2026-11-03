import { sendPartnerForgotPassword } from "@/server/partners/memberships";
import { forgotPasswordGenericResult, sendForgotPassword } from "@/server/access-management";
import { MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = (await request.json().catch(() => ({}))) as { email?: string };
    const result = new URL(request.url).searchParams.get("module") === "partner" ? await sendPartnerForgotPassword(input.email, request) : await sendForgotPassword(input.email, request);

    return Response.json(result);
  } catch (error) {
    if (!(error instanceof MutationError)) {
      console.error("Forgot password failed:", error);
    }

    return Response.json(forgotPasswordGenericResult());
  }
}
