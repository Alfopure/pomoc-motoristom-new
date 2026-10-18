/** Back target of the visible module sub-screen (case detail, call detail…).
 * The top bar shows the most recent active registration; a screen registers
 * only while it is visible, so at most one is normally present. */
export type ShellBackEntry = { label: string; onBack: () => void; disabled: boolean };

export class ShellBackStore {
  private entries = new Map<number, ShellBackEntry>();
  private order: number[] = [];
  private top: ShellBackEntry | null = null;
  private listeners = new Set<() => void>();
  private sequence = 0;

  snapshot = () => this.top;
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  nextId() { return ++this.sequence; }
  set(id: number, entry: ShellBackEntry | null) {
    this.order = this.order.filter(value => value !== id);
    if (entry) { this.entries.set(id, entry); this.order.push(id); }
    else this.entries.delete(id);
    const last = this.order.length ? this.entries.get(this.order[this.order.length - 1]) ?? null : null;
    if (last === this.top) return;
    this.top = last;
    for (const notify of this.listeners) notify();
  }
}
