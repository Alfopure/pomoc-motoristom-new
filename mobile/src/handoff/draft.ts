import type { MobileCaseHandoffs, MobileHandoffGrant, MobileHandoffInput, MobileHandoffMutation, MobileHandoffSnapshot } from '../../../src/lib/mobile-api';
import { MobileApiError } from '../lib/api';
import type { HandoffApi } from './api';
import { parseDueAt } from '../work/commands';
import { DraftNotSentError, type DraftPort, type DraftWrite } from '../drafts/port';
import { handoffProjection, restoreHandoff } from './persistence';
const receiptStorageError = 'Zápis je potvrdený, ale miestne uloženie potvrdenia zlyhalo. Najprv opravte uloženie konceptov.';
async function finishDraft(write: DraftWrite | undefined, payload: object) {
  try { return write ? await write.finish(payload) : true; } catch { return false; }
}
function localTime(value: string | null | undefined) {
  if (!value)
    return '';
  const d = new Date(value), p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
type Action = Exclude<MobileHandoffInput['action'], 'recover'>;
type Input = {
  recipientName: string;
  recipientPhone: string;
  instructions: string;
  scheduledAt: string;
  hours: string;
  comment: string;
};
type Selected = {
  action: Action;
  preview: MobileHandoffSnapshot;
  previewVersion: string;
  handoffId?: string;
  expectedRevision?: number;
};
type CachedLink = {
  url: string;
  handoffId: string;
  currentRevision: number;
  expiresAt: string;
};
export type HandoffState = {
  now: number;
  context: MobileCaseHandoffs | null;
  selected: Selected | null;
  input: Input;
  status: 'editing' | 'saving' | 'uncertain' | 'conflict' | 'saved';
  pending: MobileHandoffInput | null;
  receipt: MobileHandoffMutation | null;
  link: CachedLink | null;
  error: string | null;
  loading: boolean;
  recovering: boolean;
  canRebase: boolean;
};
const active = (grant: MobileHandoffGrant) => ['offered', 'accepted', 'en_route', 'arrived'].includes(grant.status) && Date.parse(grant.expiresAt) > Date.now();
const message = (error: unknown) => error instanceof MobileApiError || error instanceof DraftNotSentError ? error.message : 'Požiadavku sa nepodarilo dokončiť.';
const initialInput = (): Input => ({
  recipientName: '', recipientPhone: '', instructions: '', scheduledAt: '', hours: '24', comment: ''
});
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
/** A reviewed command keeps its UTC schedule even if the device timezone changes. */
export function previewSnapshot(state: HandoffState): MobileHandoffSnapshot | null {
  if (!state.selected)
    return null;
  const pending = state.pending;
  if (pending && (pending.action === 'issue' || pending.action === 'publish') && ['saving', 'uncertain', 'saved'].includes(state.status))
    return { ...state.selected.preview, instructions: pending.instructions ?? '', scheduledAt: pending.scheduledAt ?? null };
  let scheduledAt: string | null = null;
  try {
    scheduledAt = parseDueAt(state.input.scheduledAt);
  }
  catch { /* Submission rejects invalid local time before sending. */
  }
  return { ...state.selected.preview, instructions: state.input.instructions.trim(), scheduledAt };
}
/** Retained by the authenticated Cases workspace. URLs never enter query/persistent caches. */
export class HandoffDraft {
  private state: HandoffState = {
    now: Date.now(), context: null, selected: null, input: initialInput(), status: 'editing', pending: null, receipt: null, link: null, error: null, loading: false, recovering: false, canRebase: false
  };
  private listeners = new Set<() => void>();
  private disposed = false;
  private rejected = false;
  private sending = false;
  private epoch = 0;
  private read = 0;
  private recovery = 0;
  private readAbort: AbortController | null = null;
  constructor(private api: HandoffApi, readonly caseId: string, private uuid: () => string, private changed: () => void = () => {}, private port?: DraftPort) {
    const value = port?.load();
    if (port && value !== null) {
      try {
        const restored = restoreHandoff(value, caseId, port!);
        this.state = { ...this.state, ...restored, error: restored.status === 'uncertain' ? 'Obnovená požiadavka nemá potvrdený výsledok. Overte pôvodný zápis.' : restored.status === 'conflict' ? 'Obnovený koncept vyžaduje aktuálny náhľad a vedomé potvrdenie nových údajov.' : null };
      } catch { this.rejected = true; port!.reject(); this.state.error = 'Uložený koncept odovzdania sa nepodarilo overiť.'; }
    }
  }
  exportDraft() { return handoffProjection(this.caseId, this.state); }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(value: Partial<HandoffState>, persist = true) {
    if (this.disposed)
      return;
    this.state = { ...this.state, ...value };
    if (persist && !this.rejected && ['input', 'selected', 'status', 'pending', 'receipt'].some(key => key in value)) this.port?.changed(this.exportDraft());
    for (const listener of this.listeners)
      listener();
  }
  pause() {
    this.read++;
    this.readAbort?.abort();
    this.readAbort = null;
    this.set({ loading: false });
    this.expire();
  }
  async refresh() {
    if (this.disposed)
      return;
    this.readAbort?.abort();
    const controller = new AbortController();
    this.readAbort = controller;
    const read = ++this.read;
    const wasConflict = this.state.status === 'conflict';
    this.set({ loading: true });
    try {
      const context = await this.api.context(this.caseId, controller.signal);
      if (this.disposed || read !== this.read)
        return;
      this.epoch++;
      const cached = this.state.link, grant = context.handoffs.find(h => h.id === cached?.handoffId);
      const link = cached && grant && active(grant) && grant.revision === cached.currentRevision && Date.parse(cached.expiresAt) > Date.now() ? cached : null;
      this.set({
        now: Date.now(), context, link, error: null, canRebase: wasConflict && this.state.status === 'conflict'
      });
    }
    catch (error) {
      if (this.disposed || read !== this.read || controller.signal.aborted)
        return;
      if (error instanceof MobileApiError && [401, 403, 409].includes(error.status)) {
        this.epoch++;
        this.set({ link: null, context: null });
      }
      this.set({ error: message(error) });
    }
    finally {
      if (read === this.read) {
        this.readAbort = null;
        this.set({ loading: false });
      }
    }
  }
  select(action: Action, handoffId?: string) {
    if (this.disposed || this.rejected || this.sending || this.state.status === 'saved' && this.port && !this.port.settled() || ['uncertain', 'conflict'].includes(this.state.status))
      return false;
    const context = this.state.context;
    if (!context)
      return false;
    const grant = context.handoffs.find(h => h.id === handoffId);
    if (action === 'issue' && context.handoffs.some(active) || action !== 'issue' && !grant)
      return false;
    if (grant && (action === 'publish' && !active(grant) || ['renew', 'extend', 'revoke'].includes(action) && !grant.canRenew || action === 'extend' && !context.enhanced))
      return false;
    this.epoch++;
    this.set({
      selected: {
        action, preview: copy(context.preview), previewVersion: context.previewVersion, ...(grant ? { handoffId: grant.id, expectedRevision: grant.revision } : {})
      }, status: 'editing', pending: null, receipt: null, error: null, canRebase: false, input: {
        ...this.state.input, instructions: grant?.published?.instructions ?? this.state.input.instructions, scheduledAt: grant ? localTime(grant.published?.scheduledAt) : this.state.input.scheduledAt, comment: ''
      }
    });
    return true;
  }
  edit(value: Partial<Input>) {
    if (!this.rejected && this.state.status === 'editing' && !this.sending)
      this.set({ input: { ...this.state.input, ...value } });
  }
  rebase() {
    if (this.state.status !== 'conflict' || !this.state.canRebase || this.state.loading || !this.state.selected)
      return false;
    const { action, handoffId } = this.state.selected, input = this.state.input;
    this.set({ status: 'editing' }, false);
    if (!this.select(action, handoffId)) {
      this.set({ status: 'conflict', error: 'Aktuálny stav túto akciu neumožňuje.' });
      return false;
    }
    this.set({ input });
    return true;
  }
  cancel() {
    if (this.rejected || this.sending || this.state.status === 'saved' && this.port && !this.port.settled() || this.state.status === 'uncertain' || this.state.status === 'conflict' && (!this.state.canRebase || this.state.loading))
      return;
    this.set({
      selected: null, pending: this.state.receipt ? this.state.pending : null, status: this.state.receipt ? 'saved' : 'editing', error: null
    });
  }
  private command(): MobileHandoffInput {
    const s = this.state.selected, i = this.state.input;
    if (!s)
      throw new MobileApiError('Vyberte akciu.', 400);
    if (Object.values(i).some(value => Array.from(value).some(char => {
      const code = char.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    })))
      throw new MobileApiError('Text obsahuje neplatný znak. Opravte ho pred odoslaním.', 400);
    const commandId = this.uuid();
    const target = { handoffId: s.handoffId!, expectedRevision: s.expectedRevision! };
    const hours = Number(i.hours);
    if (['issue', 'renew', 'extend'].includes(s.action) && (!Number.isInteger(hours) || hours < 1 || hours > 72))
      throw new MobileApiError('Platnosť musí byť 1 až 72 hodín.', 400);
    if (s.action === 'revoke') {
      const comment = i.comment.trim();
      if (!comment || comment.length > 1000 || /[\x00-\x1f\x7f]/.test(comment))
        throw new MobileApiError('Uveďte dôvod zrušenia (najviac 1 000 znakov).', 400);
      return {
        action: 'revoke', commandId, ...target, comment
      };
    }
    if (s.action === 'renew' || s.action === 'extend')
      return {
        action: s.action, commandId, ...target, hours
      };
    const instructions = i.instructions.trim();
    if (instructions.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(instructions))
      throw new MobileApiError('Skontrolujte pokyny (najviac 2 000 znakov).', 400);
    let scheduledAt: string | null;
    try {
      scheduledAt = parseDueAt(i.scheduledAt);
    }
    catch {
      throw new MobileApiError('Skontrolujte dohodnutý dátum a čas (RRRR-MM-DD HH:mm).', 400);
    }
    const common = {
      commandId, previewVersion: s.previewVersion, instructions, scheduledAt
    };
    if (s.action === 'publish')
      return { action: 'publish', ...common, ...target };
    const recipientName = i.recipientName.trim(), recipientPhone = i.recipientPhone.trim();
    if (!recipientName || recipientName.length > 160 || !/^\+?[\d ()-]{5,30}$/.test(recipientPhone) || /[\x00-\x1f\x7f]/.test(recipientName))
      throw new MobileApiError('Vyplňte meno a platné telefónne číslo kolegu.', 400);
    return {
      action: 'issue', ...common, recipientName, recipientPhone, hours
    };
  }
  async submit() {
    if (this.disposed || this.rejected || this.sending || this.state.status !== 'editing')
      return;
    let command: MobileHandoffInput;
    try {
      command = this.command();
    }
    catch (error) {
      this.set({ error: message(error) });
      return;
    }
    this.set({ pending: copy(command) }, false);
    return this.send(false);
  }
  async reconcile() {
    if (this.disposed || this.rejected || this.sending || !this.state.pending || !['uncertain', 'saved'].includes(this.state.status))
      return;
    if (this.state.status === 'saved' && this.port && !this.port.settled()) { this.set({ error: receiptStorageError }, false); return; }
    return this.send(true);
  }
  private async send(replay: boolean) {
    const pending = this.state.pending;
    if (!pending)
      return;
    this.sending = true;
    const known = this.state.status === 'saved' ? this.state.receipt : null;
    const uncertain = replay && !known;
    this.pause();
    this.epoch++;
    const epoch = this.epoch;
    this.set({ status: known ? 'saved' : 'saving', error: null, ...(['renew', 'revoke', 'issue'].includes(pending.action) ? { link: null } : {}) }, false);
    const original = this.exportDraft();
    let write: DraftWrite | undefined;
    try {
      if (this.port) {
        try { write = await this.port.prepare(original); } catch (error) { throw error instanceof DraftNotSentError ? error : new DraftNotSentError(); }
        if (this.disposed || !this.port.current()) throw new DraftNotSentError();
      }
      const result = await this.api.command(this.caseId, copy(pending));
      if (result.kind !== 'mutation' || this.port && !this.port.acceptsScope(result))
        throw new MobileApiError('Potvrdenie uloženia sa nepodarilo overiť.', 502);
      const available = result.link.status === 'available' ? result.link : null;
      const receipt = { ...result, link: result.link.status === 'available' ? { status: 'not_requested' as const } : result.link };
      const persisted = await finishDraft(write, { ...original, status: 'saved', receipt });
      if (this.disposed) return;
      this.set({ status: 'saved', receipt, error: persisted ? null : receiptStorageError,
        link: epoch === this.epoch && available && Date.parse(available.expiresAt) > Date.now() ? { ...available, handoffId: result.handoffId } : null }, false);
      this.changed();
      return receipt;
    }
    catch (error) {
      const status = error instanceof MobileApiError ? error.status : 0;
      let outcome: Partial<HandoffState>;
      if (known) outcome = { status: 'saved', receipt: known, error: message(error) };
      else if (uncertain || !(error instanceof DraftNotSentError) && (status === 0 || status === 408 || status === 429 || status >= 500))
        outcome = { status: 'uncertain', error: 'Výsledok nie je potvrdený. Overte pôvodnú požiadavku; údaje zostali zachované. ' + message(error) };
      else if (status === 409)
        outcome = { status: 'conflict', canRebase: false, error: 'Stav sa zmenil. Načítajte aktuálny náhľad a vedome potvrďte nové údaje.' };
      else outcome = { status: 'editing', pending: null, error: message(error) };
      await finishDraft(write, { ...original, status: outcome.status, pending: outcome.pending === null ? null : pending, receipt: known });
      if (this.disposed) return;
      this.set({ ...outcome, ...([401, 403, 409].includes(status) ? { link: null } : {}) }, !write);
    }
    finally { this.sending = false; this.set({}, false); }
  }
  async recover(handoffId: string) {
    if (this.disposed || this.rejected || this.sending || this.state.recovering || ['uncertain', 'conflict'].includes(this.state.status))
      return;
    const grant = this.state.context?.handoffs.find(h => h.id === handoffId);
    if (!this.state.context?.enhanced || !grant || !active(grant) || !grant.recoverable)
      return;
    const epoch = this.epoch, recovery = ++this.recovery;
    this.set({ recovering: true, error: null, link: null });
    try {
      if (this.port) {
        // Recovery has no grant-mutation receipt. Finish its scope/storage gate
        // before retrieval so no late link response can overwrite a newer draft.
        const original = this.exportDraft();
        let gate: DraftWrite | undefined;
        this.sending = true;
        try {
          try { gate = await this.port.prepare(original); } catch { throw new DraftNotSentError(); }
          const ready = await finishDraft(gate, original); gate = undefined;
          if (!ready || this.disposed || !this.port.current() || epoch !== this.epoch || recovery !== this.recovery) throw new DraftNotSentError();
        } finally { if (gate) await finishDraft(gate, original); this.sending = false; this.set({}, false); }
      }
      const result = await this.api.command(this.caseId, {
        action: 'recover', commandId: this.uuid(), handoffId, expectedRevision: grant.revision
      });
      if (this.disposed || epoch !== this.epoch || recovery !== this.recovery)
        return;
      if (result.kind !== 'link')
        throw new MobileApiError('Odkaz sa nepodarilo overiť.', 502);
      if (Date.parse(result.link.expiresAt) <= Date.now())
        throw new MobileApiError('Platnosť odkazu skončila.', 410);
      this.set({ link: { ...result.link, handoffId }, error: null });
    }
    catch (error) {
      if (!this.disposed && epoch === this.epoch)
        this.set({ link: null, error: message(error) });
    }
    finally {
      if (recovery === this.recovery)
        this.set({ recovering: false });
    }
  }
  expire(now = Date.now()) {
    this.set({ now });
    if (this.state.link && Date.parse(this.state.link.expiresAt) <= now) {
      this.epoch++;
      this.set({ link: null });
    }
  }
  shareUrl(now = Date.now()) {
    this.expire(now);
    return this.state.link?.url ?? null;
  }
  get busy() {
    return this.sending;
  }
  dispose() {
    this.pause();
    this.epoch++;
    this.recovery++;
    this.state = {
      ...this.state, context: null, selected: null, pending: null, receipt: null, link: null, input: initialInput()
    };
    this.disposed = true;
    this.listeners.clear();
  }
}
