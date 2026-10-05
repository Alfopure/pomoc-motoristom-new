import { createRoot } from "react-dom/client";
import { AppReleaseBadge } from "@/components/pwa/AppReleaseBadge";
import type { AppRelease } from "@/lib/app-release";

const release: AppRelease = {
  environment: new URLSearchParams(location.search).has("production") ? "production" : "test",
  code: "a123456789ab", builtAt: "2026-10-05T08:00:00Z", commit: "123456789abcdef", deployment: "dpl_loaded",
};
const root = createRoot(document.getElementById("root")!);
function render(info: AppRelease) {
  root.render(<main className="min-h-screen bg-zinc-100"><AppReleaseBadge release={info} /></main>);
}
Object.assign(window, { replaceServerRelease: () => render({ ...release, code: "b123456789ab", builtAt: "2026-10-06T08:00:00Z", commit: "new-commit", deployment: "dpl_new" }) });
render(release);
