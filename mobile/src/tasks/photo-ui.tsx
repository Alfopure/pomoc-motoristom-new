import { useEffect, useState, useSyncExternalStore } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { randomUUID } from "expo-crypto";
import type { EmployeeTask } from "../../../src/lib/mobile-task-workspace";
import { Button, Card, ErrorNotice } from "../ui";
import { SectionHeader } from "../design/list";
import { palette, radius, space, type } from "../design/tokens";
import { preparePhotoPicker } from "../work/pickers";
import type { PickedFile } from "../work/attachments";
import type { EmployeeTasksApi, TaskPhoto } from "./api";
import { TaskPhotoRemoval, type TaskPhotos } from "./photos";

export function photoDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 4096) binary += String.fromCharCode(...bytes.subarray(index, index + 4096));
  return `data:${mime};base64,${btoa(binary)}`;
}
export function PhotoSelection({ photos, photoKey, task, active, onChanged, disabled: blocked = false }: {
  photos: TaskPhotos; photoKey: string; task?: EmployeeTask; active: boolean; onChanged?: () => void; disabled?: boolean;
}) {
  useSyncExternalStore(photos.subscribe, photos.snapshot, photos.snapshot);
  const state = photos.get(photoKey), photo = state.photo;
  const [picker, setPicker] = useState<((camera: boolean) => Promise<PickedFile | null>) | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    let current = true;
    if (active && photo) void photos.read(photoKey).then(bytes => { if (current) setPreview(bytes ? { id: photo.attachmentId, url: photoDataUrl(bytes, photo.mimeType) } : null); }).catch(() => { if (current) setError("Náhľad fotografie sa nepodarilo načítať z cache telefónu. Skúste nahrávanie znova alebo vyberte fotografiu nanovo."); });
    return () => { current = false; };
  }, [active, photo, photos, photoKey]);
  const choose = async (camera: boolean) => {
    if (!picker) return;
    setBusy(true); setError(null);
    try { const result = await picker(camera); if (result) await photos.select(photoKey, result); setPicker(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Fotografiu sa nepodarilo vybrať."); }
    finally { setBusy(false); }
  };
  const disabled = blocked || busy || state.status === "saving";
  return <View style={styles.inset}>
    {error || state.error ? <ErrorNotice message={error ?? state.error!} /> : null}
    {photo ? <Card>
      {active && preview?.id === photo.attachmentId ? <Image source={{ uri: preview.url }} accessibilityLabel="Vybraná fotografia úlohy" resizeMode="contain" style={styles.image} /> : null}
      <Text style={styles.text}>{photo.fileName}</Text>
      <Text style={styles.note}>{state.missing ? "Cache telefónu už fotografiu neobsahuje." : task ? "Fotografia čaká na potvrdenie pri úlohe." : "Fotografia sa nahrá po vytvorení úlohy."}</Text>
      {task && task.permissions.attach !== false && !state.missing ? <Button secondary label={state.status === "saving" ? "Nahrávam…" : state.status === "uncertain" ? "Overiť nahrávanie fotografie" : "Nahrať fotografiu"}
        disabled={disabled} onPress={() => { void photos.upload(photoKey, task).then(receipt => { if (receipt) onChanged?.(); }); }} /> : null}
      <Button secondary label="Odstrániť miestny výber fotografie" disabled={disabled} onPress={() => { void photos.discard(photoKey); }} />
    </Card> : picker ? <Card><Text style={styles.text}>Odkiaľ pridať fotografiu?</Text>
      <Button secondary label="Fotoaparát" disabled={disabled} onPress={() => { void choose(true); }} />
      <Button secondary label="Galéria" disabled={disabled} onPress={() => { void choose(false); }} />
      <Button secondary label="Zrušiť výber fotografie" disabled={disabled} onPress={() => setPicker(null)} />
    </Card> : <Button secondary label={busy ? "Pripravujem výber…" : "Pridať fotku"} disabled={disabled} onPress={() => {
      setBusy(true); setError(null);
      void preparePhotoPicker().then(value => setPicker(() => value)).catch(failure => setError(failure instanceof Error ? failure.message : "Výber fotografie nie je dostupný.")).finally(() => setBusy(false));
    }} />}
  </View>;
}

export function TaskPhotoList({ task, api, active, onChanged, disabled }: { task: EmployeeTask; api: EmployeeTasksApi; active: boolean; onChanged: () => void; disabled: boolean }) {
  if (!task.attachments?.length) return null;
  return <><SectionHeader title="Fotografie" detail={String(task.attachments.length)} /><View style={styles.inset}>
    {task.attachments.map(photo => <SavedPhoto key={photo.id} photo={photo} task={task} api={api} active={active} onChanged={onChanged} disabled={disabled} />)}
  </View></>;
}
function SavedPhoto({ photo, task, api, active, onChanged, disabled }: { photo: TaskPhoto; task: EmployeeTask; api: EmployeeTasksApi; active: boolean; onChanged: () => void; disabled: boolean }) {
  const [image, setImage] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [remove, setRemove] = useState(false);
  const [removal] = useState(() => new TaskPhotoRemoval(api, task.id, photo.id, randomUUID));
  const removalState = useSyncExternalStore(removal.subscribe, removal.snapshot, removal.snapshot);
  useEffect(() => () => removal.dispose(), [removal]);
  useEffect(() => {
    if (!image) return;
    const timer = setTimeout(() => setImage(null), Math.max(0, Date.parse(image.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [image]);
  const load = async () => {
    if (!api.photoRead) return;
    setBusy(true); setError(null);
    try { setImage(await api.photoRead(task.id, photo.id)); } catch (failure) { setError(failure instanceof Error ? failure.message : "Fotografiu sa nepodarilo otvoriť."); }
    finally { setBusy(false); }
  };
  const discard = async () => {
    await removal.remove(task.revision); onChanged();
  };
  return <Card><Text style={styles.text}>{photo.fileName}</Text>
    {active && image ? <Image source={{ uri: image.url }} accessibilityLabel={photo.fileName} resizeMode="contain" style={styles.image} /> : null}
    {error || removalState.error ? <ErrorNotice message={error ?? removalState.error!} /> : null}
    <Button secondary label={busy ? "Načítavam…" : image ? "Obnoviť náhľad fotografie" : "Zobraziť fotografiu"} disabled={disabled || busy || removalState.status === "saving"} onPress={() => { void load(); }} />
    {photo.canRemove ? remove ? <><Text style={styles.note}>Odstrániť túto fotografiu z úlohy?</Text><Button secondary label={removalState.status === "conflict" ? "Skontrolovať a zopakovať odstránenie" : removalState.pending ? "Overiť odstránenie fotografie" : "Potvrdiť odstránenie fotografie"} disabled={disabled || busy || removalState.status === "saving"} onPress={() => { void discard(); }} />
      {!removalState.pending ? <Button secondary label="Ponechať fotografiu" disabled={busy} onPress={() => setRemove(false)} /> : null}</> : <Button secondary label="Odstrániť fotografiu" disabled={disabled || busy || removalState.status === "saving"} onPress={() => setRemove(true)} /> : null}
  </Card>;
}
const styles = StyleSheet.create({
  inset: { paddingHorizontal: space.l, paddingTop: space.m, gap: space.m },
  image: { width: "100%", height: 220, borderRadius: radius.m, backgroundColor: palette.fill },
  text: { ...type.body, color: palette.label }, note: { ...type.caption, color: palette.secondaryLabel },
});
