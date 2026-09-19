import { createRoot } from "react-dom/client";
import { HeaderCallbackMenu } from "../../src/components/dispatch/HeaderCallbackMenu";
import { CallbackQueuePanel } from "../../src/components/dispatch/CallbackQueuePanel";
import { telephonyJson, TELEPHONY_TIMEOUT_MS } from "../../src/lib/telephony/client-request";

const actor = new URL(location.href).searchParams.get("actor") ?? "one";
const onCallBack = async (id: string, verificationId?: string) => {
  const response = await telephonyJson<{ error?: string }>(`/api/telephony/callbacks/${id}/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verificationId }), label: "test spätného volania", timeoutMs: TELEPHONY_TIMEOUT_MS.control });
  if (!response.ok) throw new Error(response.body?.error ?? "Volanie sa nepodarilo.");
};
createRoot(document.getElementById("root")!).render(<div className="min-h-screen bg-[#eff2f7] p-3">
  <header className="mb-3 flex justify-end rounded-xl bg-white p-3"><HeaderCallbackMenu scopeKey={actor} organizationId="fixture" configured onOpenQueue={() => {}} onCallBack={onCallBack} /></header>
  <main data-testid="callback-workspace" className="max-w-lg"><CallbackQueuePanel configured scopeKey={actor} organizationId="fixture" onCallBack={onCallBack} /></main>
</div>);
