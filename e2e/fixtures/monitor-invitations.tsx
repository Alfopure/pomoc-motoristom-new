import { createRoot } from "react-dom/client";
import { CallMonitorInvitations } from "../../src/components/dispatch/CallMonitorInvitations";
const owner = new URLSearchParams(location.search).has("owner");
createRoot(document.getElementById("root")!).render(<CallMonitorInvitations sessionId={owner ? "call-1" : null} listeningSessionId={null}
  onStop={sessionId => { void fetch(`/api/telephony/calls/${sessionId}/stop-supervise`, { method: "POST" }); }} onAccept={async (sessionId, invitationId) => {
    await fetch(`/api/telephony/calls/${sessionId}/monitor-invitations`, { method: "POST", body: JSON.stringify({ action: "accept", invitationId }) });
  }} />);
