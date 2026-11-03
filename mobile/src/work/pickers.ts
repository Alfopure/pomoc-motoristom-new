import { Platform } from "react-native";
import { MAX_BYTES, photoSize, validateFile, type PickedFile } from "./attachments";
const unavailable = () => new Error("Výber súborov v tejto verzii aplikácie nie je dostupný. Použite aktuálnu aplikáciu Expo Go alebo novú natívnu zostavu.");

type FileSystem = typeof import("expo-file-system");
type CacheProducer = "DocumentPicker" | "ImagePicker" | "ImageManipulator";

function localPath(uri: string): string | null {
  // Inspect before URL normalization: normalization would hide traversal segments.
  if (!/^file:\/\/\//.test(uri) || /[?#\\\x00-\x20]|%(?:2f|5c|25)/i.test(uri)) return null;
  const path = decodeURIComponent(uri.slice("file://".length));
  const segments = path.split("/");
  if (segments.some((part, index) => part === "." || part === ".." || (!part && index > 0 && index < segments.length - 1))) return null;
  return path;
}

function deleteCacheCopy(files: FileSystem, uri: string | undefined, producer: CacheProducer) {
  if (!uri) return;
  if (Platform.OS === "web") {
    revokeObjectCopy(uri);
    return;
  }
  try {
    const cache = localPath(files.Paths.cache.uri);
    const path = localPath(uri);
    if (!cache || !path) return;
    const root = cache.endsWith("/") ? cache : cache + "/";
    if (!path.startsWith(root)) return;
    const relative = path.slice(root.length);
    const parts = relative.split("/");
    const directCopy = parts.length === 2 && parts[0] === producer;
    // Installed iOS ImagePicker can use the cache root when its legacy cache
    // directory already ends with '/'. Both native producers generate UUID names.
    const iosRootCopy = Platform.OS === "ios" && producer === "ImagePicker" && parts.length === 1;
    if (!(directCopy || iosRootCopy) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.[^/\\\x00-\x1f\x7f]*$/i.test(parts.at(-1)!)) return;
    new files.File(uri).delete();
  } catch { /* Cache cleanup must not replace prepared bytes or the original error. */ }
}

function revokeObjectCopy(uri: unknown) {
  if (Platform.OS !== "web" || typeof uri !== "string" || !uri.startsWith("blob:")) return;
  try {
    URL.revokeObjectURL(uri);
  } catch { /* The captured bytes remain usable. */ }
}

function release(resource: { release(): void } | undefined) {
  try {
    if (resource && "uri" in resource) revokeObjectCopy(resource.uri);
  } catch { /* Still release a resource whose URI is unavailable. */ }
  try {
    resource?.release();
  } catch { /* Continue releasing the other acquired resources. */ }
}

/** Called only by the explicit chooser action. The returned functions run from
 * a fresh press, preserving browser user activation after modules have loaded. */
export async function preparePhotoPicker() {
  let picker: typeof import("expo-image-picker"), manipulator: typeof import("expo-image-manipulator"), files: typeof import("expo-file-system");
  try { [picker, manipulator, files] = await Promise.all([import("expo-image-picker"), import("expo-image-manipulator"), import("expo-file-system")]); }
  catch { throw unavailable(); }
  return async (camera: boolean): Promise<PickedFile | null> => {
    if (camera && Platform.OS !== "web") {
      const permission = await picker.requestCameraPermissionsAsync();
      if (!permission.granted) throw new Error("Povoľte fotoaparát v nastaveniach telefónu alebo vyberte fotografiu z galérie.");
    }
    const options: import("expo-image-picker").ImagePickerOptions = { mediaTypes: ["images"], allowsMultipleSelection: false, allowsEditing: false, quality: 1,
      preferredAssetRepresentationMode: picker.UIImagePickerPreferredAssetRepresentationMode.Compatible, base64: false, exif: false };
    const result = await (camera ? picker.launchCameraAsync(options) : picker.launchImageLibraryAsync(options));
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset?.uri) throw new Error("Fotografiu sa nepodarilo načítať.");
    let original: ReturnType<typeof manipulator.ImageManipulator.manipulate> | undefined;
    let image: Awaited<ReturnType<NonNullable<typeof original>["renderAsync"]>> | undefined;
    try {
      original = manipulator.ImageManipulator.manipulate(asset.uri);
      image = await original.renderAsync();
      for (const attempt of [{ maximum: 2048, compress: 0.8 }, { maximum: 2048, compress: 0.6 }, { maximum: 1536, compress: 0.7 }]) {
        let context: typeof original | undefined;
        let rendered: typeof image | undefined;
        let savedUri: string | undefined;
        try {
          context = manipulator.ImageManipulator.manipulate(image);
          context.resize(photoSize(image.width, image.height, attempt.maximum));
          rendered = await context.renderAsync();
          const saved = await rendered.saveAsync({ format: manipulator.SaveFormat.JPEG, compress: attempt.compress });
          savedUri = saved.uri;
          if (!Number.isFinite(saved.width) || !Number.isFinite(saved.height) || saved.width > attempt.maximum || saved.height > attempt.maximum || saved.width <= 0 || saved.height <= 0) throw new Error("Rozmery upravenej fotografie sa nepodarilo overiť.");
          const file = Platform.OS === "web" ? null : new files.File(saved.uri);
          if (file && file.size > MAX_BYTES) continue;
          const bytes = Platform.OS === "web" ? new Uint8Array(await (await fetch(saved.uri)).arrayBuffer()) : await file!.bytes();
          if (bytes.length > MAX_BYTES) continue;
          validateFile(bytes, "image/jpeg");
          const originalName = (asset.fileName ?? "fotografia").replace(/\.[^.]+$/, "").replace(/[\x00-\x1f\x7f/\\]/g, "_").trim();
          // Preserve a readable name while staying within the server's UTF8 limit.
          const name = Array.from(originalName || "fotografia").slice(0, 50).join("") + ".jpg";
          return { bytes, fileName: name, mimeType: "image/jpeg", category: "photo" };
        } finally {
          deleteCacheCopy(files, savedUri, "ImageManipulator");
          release(rendered);
          release(context);
        }
      }
      throw new Error("Fotografia je aj po zmenšení príliš veľká. Vyberte menšiu fotografiu.");
    } finally {
      release(image);
      release(original);
      deleteCacheCopy(files, asset.uri, "ImagePicker");
    }
  };
}
export async function prepareDocumentPicker() {
  let picker: typeof import("expo-document-picker"), files: typeof import("expo-file-system");
  try { [picker, files] = await Promise.all([import("expo-document-picker"), import("expo-file-system")]); } catch { throw unavailable(); }
  return async (): Promise<PickedFile | null> => {
    const result = await picker.getDocumentAsync({ type: ["image/jpeg", "image/png", "application/pdf"], multiple: false, copyToCacheDirectory: true });
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset) throw new Error("Súbor sa nepodarilo načítať.");
    try {
      const file = Platform.OS === "web" ? null : new files.File(asset.uri);
      if ((asset.file?.size ?? file?.size ?? asset.size ?? 0) > MAX_BYTES) throw new Error("Dokument musí mať najviac 3 MiB.");
      const bytes = asset.file ? new Uint8Array(await asset.file.arrayBuffer()) : file ? await file.bytes() : null;
      if (!bytes) throw new Error("Súbor sa nepodarilo načítať.");
      const mimeType = validateFile(bytes);
      return { bytes, fileName: asset.name, mimeType, category: "document" };
    } finally {
      deleteCacheCopy(files, asset.uri, "DocumentPicker");
    }
  };
}
