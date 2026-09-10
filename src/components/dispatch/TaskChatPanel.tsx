"use client";
import { TASK_MESSAGE_LIMIT } from "@/domain/task-workspace";
import { useTaskWorkspace } from "./TaskWorkspaceProvider";
import styles from "./TaskWorkspacePanel.module.css";
export function TaskChatPanel({ taskId }: { taskId: string }) {
  const { store, snapshot } = useTaskWorkspace();
  const chat = snapshot.chats[taskId], draft = snapshot.chatDrafts[taskId] ?? "", pending = snapshot.pendingMessages[taskId];
  return <section aria-label="Chat úlohy" className={styles.section}>
    <div className={styles.row}><h3>Chat úlohy</h3><button type="button" onClick={() => void store.loadMessages(taskId)}>Obnoviť správy</button></div>
    {chat?.nextCursor && <button type="button" onClick={() => void store.loadMessages(taskId, true)}>Načítať staršie správy</button>}
    <div role="log" aria-label="Správy úlohy" aria-live="polite" className={styles.messages}>
      {chat?.messages.map(message => <article key={message.id}><p><strong>{message.authorName}</strong> <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString("sk-SK")}</time></p><p className={styles.messageBody}>{message.body}</p></article>)}
      {chat?.loaded && chat.messages.length === 0 && <p>Zatiaľ bez správ.</p>}
      {!chat?.loaded && <p>Správy sa načítavajú. Pri výpadku pripojenia použite Obnoviť správy.</p>}
    </div>
    <label>Správa k úlohe<textarea aria-label="Správa k úlohe" value={draft} maxLength={TASK_MESSAGE_LIMIT} onChange={event => store.editChat(taskId, event.target.value)} rows={4} /></label>
    <div className={styles.row}><span>{draft.length.toLocaleString("sk-SK")} / 10 000</span><button type="button" disabled={snapshot.saving || (!draft.trim() && !pending)} onClick={() => void store.sendMessage(taskId)}>{snapshot.saving ? "Odosielam…" : pending ? "Overiť a zopakovať odoslanie" : "Odoslať správu"}</button></div>
    {pending && !snapshot.saving && <p>Potvrdenie správy ešte neprišlo. Opakovanie overí rovnakú správu bez vytvorenia kópie.</p>}
  </section>;
}
