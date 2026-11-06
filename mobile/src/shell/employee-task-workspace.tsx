import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { randomUUID } from "expo-crypto";
import type { MobileConfig } from "../lib/config";
import { DraftVault, type DraftScope } from "../drafts/vault";
import { createDraftStorage } from "../drafts/storage";
import { formLayout } from "../design/form";
import { Button, ErrorNotice, Loading, styles } from "../ui";
import { createEmployeeTasksApi } from "../tasks/api";
import { createUploadFiles } from "../field-work/upload-files";
import { EmployeeTasksStore } from "../tasks/store";
import { EmployeeTasks } from "../tasks/ui";

type Props = {
  config: MobileConfig; userId: string; memberId: string; organizationId: string;
  getToken: () => Promise<string | null>; current: () => boolean;
  active: boolean; onLeave: () => void; openTaskRequest?: { taskId: string | null; nonce: number };
};
type Resource = { vault: DraftVault; store: EmployeeTasksStore | null };

/** Field staff use the same private draft protocol as dispatchers. A fresh
 * employee authorization precedes hydration; their membership ID only scopes
 * local storage and never stands in for a dispatch profile on the server. */
export function FieldEmployeeTaskWorkspace(props: Props) {
  const { config, userId, memberId, organizationId, getToken, current } = props;
  const api = useMemo(() => createEmployeeTasksApi(config, getToken, userId, organizationId), [config, getToken, userId, organizationId]);
  const scope = useMemo<DraftScope>(() => ({ environment: config.environment, projectUrl: config.supabaseUrl,
    userId, profileId: memberId, organizationId }), [config.environment, config.supabaseUrl, userId, memberId, organizationId]);
  const [resource, setResource] = useState<Resource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true, vault: DraftVault | null = null, store: EmployeeTasksStore | null = null;
    const controller = new AbortController();
    const isCurrent = () => alive && current();
    const unsubscribe = api.subscribeAccessLoss(() => {
      store?.dispose(); vault?.close();
      if (alive) { setResource(null); setError("Prístup k úlohám sa zmenil. Obnovte oprávnenia pred pokračovaním."); }
    });
    async function open() {
      try {
        await api.directory("", controller.signal);
        if (!isCurrent()) return;
        const driver = createDraftStorage(scope);
        vault = await DraftVault.open(driver.storage, scope, { durable: driver.durable, uuid: randomUUID,
          current: isCurrent, revalidate: async () => { await api.directory(); if (!isCurrent()) throw new Error("Prihlásenie sa zmenilo."); } });
        if (!isCurrent()) { vault.close(); return; }
        if (vault.snapshot().ready) store = new EmployeeTasksStore(api, userId, { id: randomUUID,
          createPort: vault.bind("employee-task-create", userId), commandPort: id => vault!.bind("employee-task-command", id), photoPort: id => vault!.bind("employee-task-photo", id),
          photoFiles: createUploadFiles(["task", config.environment, new URL(config.supabaseUrl).hostname.split(".")[0], userId, organizationId].join(".")) });
        setResource({ vault, store }); setError(null);
      } catch (failure) {
        store?.dispose(); vault?.close();
        if (isCurrent()) setError(failure instanceof Error ? failure.message : "Koncepty úloh sa nepodarilo obnoviť.");
      }
    }
    void open();
    return () => { alive = false; controller.abort(); unsubscribe(); store?.dispose(); vault?.close(); };
  }, [api, config.environment, config.supabaseUrl, organizationId, current, scope, userId, attempt]);
  const retry = () => { setResource(null); setError(null); setAttempt(value => value + 1); };
  if (!resource) return <ScrollView contentContainerStyle={formLayout.content}><View style={formLayout.notices}>
    {error ? <ErrorNotice message={error} onRetry={retry} /> : <Loading label="Overujem prístup a obnovujem koncepty úloh…" />}
  </View></ScrollView>;
  return <FieldTasksReady {...props} resource={resource} retry={retry} />;
}

function FieldTasksReady({ resource, retry, ...props }: Props & { resource: Resource; retry: () => void }) {
  const state = useSyncExternalStore(resource.vault.subscribe, resource.vault.snapshot, resource.vault.snapshot);
  const [error, setError] = useState<string | null>(null);
  const discard = () => Alert.alert("Zahodiť miestne koncepty úloh?", "Rozpísané údaje sa odstránia iba z tohto zariadenia. Úlohy už uložené na serveri zostanú zachované.", [
    { text: "Ponechať", style: "cancel" }, { text: "Zahodiť koncepty", style: "destructive", onPress: () => {
      void resource.vault.discardAll().then(retry).catch(failure => setError(failure instanceof Error ? failure.message : "Koncepty sa nepodarilo odstrániť."));
    } },
  ]);
  return <View style={{ flex: 1 }}>
    {(state.error || error || !state.durable) && <View style={formLayout.notices}>
      {!state.durable && <Text style={styles.muted}>Koncepty v tomto náhľade ostávajú iba do zatvorenia aplikácie.</Text>}
      {(state.error || error) && <><ErrorNotice message={error ?? state.error!} onRetry={() => {
        void resource.vault.retry().then(() => { if (!resource.store) retry(); }).catch(failure => setError(String(failure)));
      }} /><Button label="Zahodiť miestne koncepty úloh" secondary disabled={state.busy || state.saving} onPress={discard} /></>}
    </View>}
    {resource.store && state.ready ? <EmployeeTasks config={props.config} getToken={props.getToken} userId={props.userId}
      organizationId={props.organizationId} store={resource.store} active={props.active} onLeave={props.onLeave} openTaskRequest={props.openTaskRequest} /> : null}
  </View>;
}
