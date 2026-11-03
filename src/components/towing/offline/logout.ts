import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { pendingSummary, quarantine, scopesForUser } from './store';
import { synchronize } from './sync';

/** Resolve unsent work before the shared Supabase identity is removed or changed. */
export async function prepareTowingSignOut() {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return;
  if (indexedDB.databases && !(await indexedDB.databases()).some(db => db.name === 'pm-towing-offline-v1')) return;
  const client = createSupabaseBrowserClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) return;
  const scopes = await scopesForUser(session.user.id, location.origin);
  const summaries = await Promise.all(scopes.map(pendingSummary));
  const total = summaries.reduce((sum, item) => ({ changes: sum.changes + item.changes, photos: sum.photos + item.photos, receipts: sum.receipts + item.receipts }), { changes: 0, photos: 0, receipts: 0 });
  if (total.changes) {
    const choice = await askSignOut(total);
    if (choice === 'cancel') throw new Error('Odhlásenie bolo zrušené. Neodoslaná práca ostáva v zariadení.');
    if (choice === 'sync') {
      for (const scope of scopes) await synchronize(scope, { currentUser: async () => (await client.auth.getUser()).data.user?.id ?? null });
      const pending = await Promise.all(scopes.map(pendingSummary));
      if (pending.some(s => s.changes)) throw new Error('Nie všetky záznamy sa podarilo potvrdiť. Odhlásenie bolo zrušené; najprv vyriešte čakajúcu prácu.');
    } else if (!window.confirm(`Naozaj zahodiť ${total.changes} záznamov vrátane ${total.photos} fotografií? ${total.receipts ? 'Nepotvrdené príjmy hotovosti zostanú ako obmedzený dôkaz pre kanceláriu; nejde o potvrdené platby.' : 'Neodoslané údaje už nebude možné obnoviť.'}`)) {
      throw new Error('Odhlásenie bolo zrušené.');
    }
  }
  for (const scope of scopes) await quarantine(scope);
}
function askSignOut(summary: { changes: number; photos: number; receipts: number }): Promise<'sync' | 'discard' | 'cancel'> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-labelledby', 'towing-logout-title');
    Object.assign(dialog.style, { border: '1px solid #d4d4d8', borderRadius: '16px', padding: '24px', width: 'min(92vw, 440px)', color: '#18181b', background: 'white' });
    const title = document.createElement('h2'); title.id = 'towing-logout-title'; title.textContent = 'Neodoslaná práca';
    Object.assign(title.style, { fontWeight: '700', fontSize: '20px', marginBottom: '12px' });
    const detail = document.createElement('p'); detail.textContent = `Čaká ${summary.changes} záznamov, ${summary.photos} fotografií a ${summary.receipts} príjmov hotovosti. Pred odhlásením ich synchronizujte alebo vedome zahoďte.`;
    dialog.append(title, detail);
    const finish = (value: 'sync' | 'discard' | 'cancel') => { dialog.close(); dialog.remove(); resolve(value); };
    for (const [value, label] of [['sync','Synchronizovať a odhlásiť'],['discard','Zahodiť neodoslanú prácu…'],['cancel','Zrušiť odhlásenie']] as const) {
      const action = document.createElement('button'); action.textContent = label; action.type = 'button';
      Object.assign(action.style, { display: 'block', minHeight: '44px', width: '100%', marginTop: '12px', padding: '10px', borderRadius: '8px', border: '1px solid #d4d4d8', background: value === 'sync' ? '#18181b' : 'white', color: value === 'sync' ? 'white' : '#18181b' });
      action.addEventListener('click', () => finish(value)); dialog.append(action);
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish('cancel'); });
    document.body.append(dialog); dialog.showModal();
  });
}
