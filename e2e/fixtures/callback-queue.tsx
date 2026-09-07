import { createRoot } from "react-dom/client";
import { CallbackQueuePanel } from "../../src/components/dispatch/CallbackQueuePanel";

createRoot(document.getElementById("root")!).render(<CallbackQueuePanel configured onCallBack={async (id) => {
  document.body.dataset.called = id;
}} />);
