/** Actor-scoped notebook DTOs. Never include these in DispatchData or persistent caches. */
export type PersonalNote = {
  id: string;
  ownerProfileId: string;
  title: string;
  body: string;
  revision: number;
  updatedAt: string;
  recipientProfileIds: string[];
  canEdit: boolean;
};
export type NoteColleague = { id: string; displayName: string };
export type NoteDraft = Pick<PersonalNote, "title" | "body" | "recipientProfileIds">;
export const NOTE_TITLE_LIMIT = 200;
export const NOTE_BODY_LIMIT = 50_000;
export const NOTE_RECIPIENT_LIMIT = 100;
export const NOTE_REVALIDATE_MS = 25_000;
export function sameNoteDraft(a: NoteDraft, b: NoteDraft): boolean {
  return a.title === b.title && a.body === b.body && [...a.recipientProfileIds].sort().join(",") === [...b.recipientProfileIds].sort().join(",");
}
