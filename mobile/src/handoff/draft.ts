import type { MobileCaseHandoffs, MobileHandoffGrant, MobileHandoffInput, MobileHandoffMutation, MobileHandoffSnapshot } from '../../../src/lib/mobile-api';
import { MobileApiError } from '../lib/api';
import type { HandoffApi } from './api';
import { parseDueAt } from '../work/commands';
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
const message = (error: unknown) => error instanceof MobileApiError ? error.message : 'Požiadavku sa nepodarilo dokončiť.';
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
  private sending = false;
  private epoch = 0;
  private read = 0;
  private recovery = 0;
  private readAbort: AbortController | null = null;
  constructor(private api: HandoffApi, readonly caseId: string, private uuid: () => string, private changed: () => void = () => {
  }) {
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(value: Partial<HandoffState>) {
    if (this.disposed)
      return;
    this.state = { ...this.state, ...value };
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
    if (this.disposed || this.sending || ['uncertain', 'conflict'].includes(this.state.status))
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
      }, status: 'editing', pending: null, error: null, canRebase: false, input: {
        ...this.state.input, instructions: grant?.published?.instructions ?? this.state.input.instructions, scheduledAt: grant ? localTime(grant.published?.scheduledAt) : this.state.input.scheduledAt, comment: ''
      }
    });
    return true;
  }
  edit(value: Partial<Input>) {
    if (this.state.status === 'editing' && !this.sending)
      this.set({ input: { ...this.state.input, ...value } });
  }
  rebase() {
    if (this.state.status !== 'conflict' || !this.state.canRebase || this.state.loading || !this.state.selected)
      return false;
    const { action, handoffId } = this.state.selected, input = this.state.input;
    this.set({ status: 'editing' });
    if (!this.select(action, handoffId)) {
      this.set({ status: 'conflict', error: 'Aktuálny stav túto akciu neumožňuje.' });
      return false;
    }
    this.set({ input });
    return true;
  }
  cancel() {
    if (this.sending || this.state.status === 'uncertain' || this.state.status === 'conflict' && (!this.state.canRebase || this.state.loading))
      return;
    this.set({
      selected: null, pending: null, status: this.state.receipt ? 'saved' : 'editing', error: null
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
    if (this.disposed || this.sending || this.state.status !== 'editing')
      return;
    let command: MobileHandoffInput;
    try {
      command = this.command();
    }
    catch (error) {
      this.set({ error: message(error) });
      return;
    }
    this.set({ pending: copy(command) });
    return this.send(false);
  }
  async reconcile() {
    if (this.disposed || this.sending || !this.state.pending || !['uncertain', 'saved'].includes(this.state.status))
      return;
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
    this.set({ status: known ? 'saved' : 'saving', error: null, ...(['renew', 'revoke', 'issue'].includes(pending.action) ? { link: null } : {}) });
    try {
      const result = await this.api.command(this.caseId, copy(pending));
      if (this.disposed)
        return;
      if (result.kind !== 'mutation')
        throw new MobileApiError('Potvrdenie uloženia sa nepodarilo overiť.', 502);
      const available = result.link.status === 'available' ? result.link : null;
      const receipt = { ...result, link: result.link.status === 'available' ? { status: 'not_requested' as const } : result.link };
      this.set({
        status: 'saved', receipt, error: null, link: epoch === this.epoch && available && Date.parse(available.expiresAt) > Date.now() ? { ...available, handoffId: result.handoffId } : null
      });
      this.changed();
      return receipt;
    }
    catch (error) {
      if (this.disposed)
        return;
      const status = error instanceof MobileApiError ? error.status : 0;
      const denied = [401, 403, 409].includes(status);
      if (denied)
        this.set({ link: null });
      if (known)
        this.set({ status: 'saved', receipt: known, error: message(error) });
      else if (uncertain || status === 0 || status === 408 || status === 429 || status >= 500)
        this.set({ status: 'uncertain', error: 'Výsledok nie je potvrdený. Overte pôvodnú požiadavku; údaje zostali zachované. ' + message(error) });
      else if (status === 409)
        this.set({ status: 'conflict', canRebase: false, error: 'Stav sa zmenil. Načítajte aktuálny náhľad a vedome potvrďte nové údaje.' });
      else
        this.set({ status: 'editing', pending: null, error: message(error) });
    }
    finally {
      this.sending = false;
      this.set({});
    }
  }
  async recover(handoffId: string) {
    if (this.disposed || this.sending || this.state.recovering || ['uncertain', 'conflict'].includes(this.state.status))
      return;
    const grant = this.state.context?.handoffs.find(h => h.id === handoffId);
    if (!this.state.context?.enhanced || !grant || !active(grant) || !grant.recoverable)
      return;
    const epoch = this.epoch, recovery = ++this.recovery;
    this.set({ recovering: true, error: null, link: null });
    try {
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
