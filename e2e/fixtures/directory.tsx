import { createRoot } from "react-dom/client";
import { IntegrationSettings } from "../../src/components/dispatch/IntegrationSettings";

createRoot(document.getElementById("root")!).render(
  <IntegrationSettings branches={[]} partnerDirectory={[]} users={[]} viewerRole="manager" pushEnabled={false}
    onDataChange={data => { document.body.dataset.refreshedSource = data.source; }}
    onDial={async phone => { document.body.dataset.called = phone; }} />,
);
