"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { protectDraftBeforeUnload } from "@/lib/draft-unload";

export type DraftEditorState = {
  dirty: boolean;
  saving: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
  hasPendingChanges?: () => boolean;
};

/** Editors register their own save action; navigation never guesses which form owns a draft. */
export function useDraftEditors() {
  const editors = useRef(new Map<string, DraftEditorState>());
  const [state, setState] = useState({ dirty: false, saving: false, labels: [] as string[] });
  const register = useCallback((label: string, editor: DraftEditorState | null) => {
    if (editor) editors.current.set(label, editor);
    else editors.current.delete(label);
    const entries = [...editors.current.entries()];
    const next = { dirty: entries.some(([, item]) => item.dirty), saving: entries.some(([, item]) => item.saving), labels: entries.filter(([, item]) => item.dirty || item.saving).map(([name]) => name) };
    setState(current => current.dirty === next.dirty && current.saving === next.saving && current.labels.join("|") === next.labels.join("|") ? current : next);
  }, []);
  useEffect(() => {
    if (!state.dirty && !state.saving) return;
    window.addEventListener("beforeunload", protectDraftBeforeUnload);
    return () => window.removeEventListener("beforeunload", protectDraftBeforeUnload);
  }, [state.dirty, state.saving]);
  const pendingLabel = useCallback(() => {
    for (const [label, editor] of editors.current) if (editor.hasPendingChanges ? editor.hasPendingChanges() : editor.dirty || editor.saving) return label;
    return null;
  }, []);
  const save = useCallback(async () => {
    for (const [label, editor] of editors.current) {
      if ((editor.dirty || editor.saving) && !await editor.save()) return label;
    }
    return pendingLabel();
  }, [pendingLabel]);
  const discard = useCallback(() => {
    if ([...editors.current.values()].some(editor => editor.saving)) return false;
    for (const editor of editors.current.values()) if (editor.dirty) editor.discard();
    return true;
  }, []);
  return { ...state, register, save, discard, pendingLabel };
}
