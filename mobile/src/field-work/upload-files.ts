import { Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import { draftId } from "../drafts/port";
import type { UploadFiles } from "./uploads";

const memory = new Map<string, Uint8Array>();

/** The bytes of unfinished towing uploads of one account (`scopeKey`): in the app's
 * caches on the phone (not backed up; iOS may clear them, then the upload can only be
 * abandoned), in memory on the web. */
export function createUploadFiles(scopeKey: string): UploadFiles {
  if (!/^[a-zA-Z0-9.-]{1,200}$/.test(scopeKey)) throw new Error("Invalid upload scope");
  if (Platform.OS === "web") return {
    read: async id => memory.get(scopeKey + "/" + id)?.slice() ?? null,
    write: async (id, bytes) => { memory.set(scopeKey + "/" + id, bytes.slice()); },
    remove: async id => { memory.delete(scopeKey + "/" + id); },
    keepOnly: async ids => { for (const key of [...memory.keys()]) if (key.startsWith(scopeKey + "/") && !ids.includes(key.slice(scopeKey.length + 1))) memory.delete(key); },
  };
  const folder = () => new Directory(Paths.cache, "pm-towing-uploads-v1", scopeKey);
  const file = (attachmentId: string) => {
    if (!draftId(attachmentId)) throw new Error("Invalid attachment id");
    return new File(folder(), attachmentId.toLowerCase() + ".bin");
  };
  return {
    read: async id => { const target = file(id); return target.exists ? await target.bytes() : null; },
    write: async (id, bytes) => {
      const target = file(id), directory = folder();
      if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
      if (target.exists) target.delete();
      target.create();
      target.write(bytes);
    },
    remove: async id => { const target = file(id); if (target.exists) target.delete(); },
    // Bytes left by an interrupted start or a failed removal; no stored upload refers to them.
    keepOnly: async ids => {
      const directory = folder();
      if (!directory.exists) return;
      const kept = new Set(ids.map(id => id.toLowerCase() + ".bin"));
      for (const entry of directory.list()) if (entry instanceof File && !kept.has(entry.name)) entry.delete();
    },
  };
}
