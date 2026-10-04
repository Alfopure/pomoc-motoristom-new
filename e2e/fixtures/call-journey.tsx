import { useState } from "react";
import { createRoot } from "react-dom/client";
import { IncomingRoutingEditor } from "../../src/components/dispatch/settings/IncomingRoutingEditor";
import { CallJourneyButton } from "../../src/components/dispatch/CallJourney";
import type { RoutingDocument } from "../../src/server/telephony/config-service";

const fixture = (window as unknown as { __journeyDocument: RoutingDocument }).__journeyDocument;
function Fixture() {
  const [document, setDocument] = useState(fixture);
  return <main><IncomingRoutingEditor document={document} canEdit onSaved={response => setDocument(response.document)} onNavigate={() => {}} /><div style={{ marginTop: 16 }}><CallJourneyButton sessionId="00000000-0000-4000-8000-000000000301" /></div></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
