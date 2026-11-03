'use client';

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { protectDraftBeforeUnload } from '@/lib/draft-unload';
import type { DraftEditorState } from '@/components/dispatch/useDraftEditors';
import { createPartnerDraftStore, hasPartnerDraft, preserveUnconfirmedPartnerCommand } from './partner-drafts';

type Store = ReturnType<typeof createPartnerDraftStore>;
type DraftContext = { store: Store; retries: Map<string, () => Promise<boolean>> };
const Context = createContext<DraftContext | null>(null);

export function PartnerDraftProvider({ children, registerDraft }: {
  children: ReactNode; registerDraft: (label: string, editor: DraftEditorState | null) => void;
}) {
  const [store] = useState(createPartnerDraftStore);
  const [retries] = useState(() => new Map<string, () => Promise<boolean>>());
  const version = useSyncExternalStore(store.subscribe, store.version, store.version);
  const hasUnconfirmed = useCallback(() => store.entries().some(([, d]) => d.pending?.unconfirmed && !d.pending.acknowledged), [store]);
  useEffect(() => {
    registerDraft('Partnerské príkazy', {
      dirty: hasUnconfirmed(), saving: false, hasPendingChanges: hasUnconfirmed,
      save: async () => {
        for (const [key, draft] of store.entries()) {
          if (draft.pending?.unconfirmed && !draft.pending.acknowledged && !await retries.get(key)?.()) return false;
        }
        return !hasUnconfirmed();
      },
      discard: () => {
        for (const [key, draft] of store.entries()) if (draft.pending?.unconfirmed) {
          store.update(key, preserveUnconfirmedPartnerCommand(draft));
        }
      },
    });
  }, [registerDraft, store, version, hasUnconfirmed, retries]);
  useEffect(() => () => registerDraft('Partnerské príkazy', null), [registerDraft]);
  useEffect(() => {
    if (!store.entries().some(([, draft]) => hasPartnerDraft(draft))) return;
    window.addEventListener('beforeunload', protectDraftBeforeUnload);
    return () => window.removeEventListener('beforeunload', protectDraftBeforeUnload);
  }, [store, version]);
  return <Context.Provider value={{ store, retries }}>{children}</Context.Provider>;
}

export function usePartnerDraftStore() {
  const shared = useContext(Context);
  const [standalone] = useState(createPartnerDraftStore);
  const [retries] = useState(() => new Map<string, () => Promise<boolean>>());
  return shared ?? { store: standalone, retries };
}
