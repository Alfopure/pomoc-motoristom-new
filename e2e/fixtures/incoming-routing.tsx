import { createRoot } from "react-dom/client";
import { useState } from "react";
import { TelephonyConfigPanel } from "@/components/dispatch/settings/TelephonyConfigPanel";
import { RoutingSummaryPanel } from "@/components/dispatch/RoutingSummaryPanel";
import type { RoutingNavigationTarget } from "@/lib/telephony/routing-summary";
import { ids } from "./incoming-routing-data";
function Fixture(){
 const [target,setTarget]=useState<RoutingNavigationTarget>({section:"telephony",tab:"incoming",lineId:ids.line,planId:ids.plan});
 return <div className="min-h-screen bg-[#EFF2F7] text-zinc-900" style={{fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'}}><header className="flex min-h-16 flex-wrap items-center gap-4 border-b border-zinc-200 bg-white px-5 py-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[#FCD703] text-sm font-bold">PM</span><span className="text-sm font-semibold">Pomoc motoristom</span><nav className="ml-auto flex items-center gap-1 rounded-xl bg-zinc-100 p-1 text-sm"><span className="px-3 py-2">Nástenka</span><span className="px-3 py-2">Ústredňa</span><span className="rounded-lg bg-white px-3 py-2 shadow-sm">Nastavenia</span></nav></header><main className="mx-auto grid max-w-6xl gap-4 p-3 sm:p-5"><p className="text-xs text-zinc-500">Izolovaná ukážka aplikácie · modelové údaje · bez pripojenia k telefónnej sieti</p><RoutingSummaryPanel onNavigate={setTarget}/><TelephonyConfigPanel routingTarget={target}/></main></div>
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
