const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PHOTO_TARGET_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 2048;

export function validateTowingFile(file: Pick<File, "type" | "size">): void {
  if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type)) throw new Error("Podporované sú JPG, PNG a PDF. HEIC exportujte ako JPG pred priložením.");
  if (file.size <= 0) throw new Error("Súbor je prázdny.");
  if (file.size > MAX_FILE_BYTES) throw new Error("Súbor je väčší ako 10 MB. Zmenšite ho pred odoslaním.");
}

/** Browser-only photo preparation shared by online upload and bounded offline. */
export async function prepareTowingImage(file: File): Promise<File> {
  validateTowingFile(file);
  if (file.type === "application/pdf") return file;
  let bitmap: ImageBitmap | null = null;
  try {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
    bitmap = await createImageBitmap(file);
    const factor = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    if (factor === 1 && file.size <= PHOTO_TARGET_BYTES) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * factor));
    canvas.height = Math.max(1, Math.round(bitmap.height * factor));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob: Blob | null = null;
    for (const quality of [0.85, 0.72, 0.58, 0.45]) {
      blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= PHOTO_TARGET_BYTES) break;
    }
    if (!blob || blob.size > MAX_FILE_BYTES || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    // Original supported bytes remain usable; the server validates real format.
    return file;
  } finally { bitmap?.close(); }
}
