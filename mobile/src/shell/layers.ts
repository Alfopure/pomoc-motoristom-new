import type { CasesApi } from "../cases/api";
import type { createCallbacksApi } from "../callbacks/api";
import type { CaseShortcut } from "../cases/filters";

/** Screens composed by the shell but fed with organization-scoped APIs that
 * exist only after the draft workspace verified the organization. */
export type ShellLayer = "home" | "search" | "alerts";
export type CallbacksApi = ReturnType<typeof createCallbacksApi>;
export type ShellScope = { cases: CasesApi; callbacks: CallbacksApi; homeKey: readonly unknown[] };
/** Open a detail or a filtered list inside its module; each checks the verified scope first. */
export type ShellOpeners = {
  openCase: (id: string) => void; openTask: (id: string) => void;
  openCases: (shortcut: CaseShortcut) => void; openTasks: () => void;
};
