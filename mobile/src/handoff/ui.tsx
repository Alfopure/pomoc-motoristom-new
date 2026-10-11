import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, KeyboardAvoidingView, Platform, ScrollView, Share, Text, TextInput, View } from 'react-native';
import type { MobileHandoffInput } from '../../../src/lib/mobile-api';
import { Button, Card, ErrorNotice, Loading, styles } from '../ui';
import { HandoffDraft, previewSnapshot } from './draft';
import { HandoffSummary, handoffTime } from './summary';
const statuses: Record<string, string> = {
  offered: 'Čaká na prijatie', accepted: 'Prijaté', en_route: 'Na ceste', arrived: 'Na mieste', completed: 'Dokončené', rejected: 'Odmietnuté', cancelled: 'Zrušené', expired: 'Platnosť skončila'
};
const events: Record<string, string> = {
  issue: 'Vytvorený odkaz', publish: 'Zverejnené údaje', renew: 'Obnovený odkaz', extend: 'Predĺžená platnosť', recover: 'Získaný odkaz', accept: 'Prijaté', reject: 'Odmietnuté', en_route: 'Na ceste', arrived: 'Na mieste', complete: 'Dokončené', update: 'Aktualizácia', blocked: 'Prístup zablokovaný', revoke: 'Zrušené'
};
const actions: Record<Exclude<MobileHandoffInput['action'], 'recover'>, string> = {
  issue: 'Vytvoriť odovzdanie', publish: 'Zverejniť aktuálne údaje', renew: 'Obnoviť odkaz', extend: 'Predĺžiť platnosť', revoke: 'Zrušiť odovzdanie'
};
const explanations = {
  issue: 'Vytvoríte prístup k nižšie uvedeným údajom. Odkaz sa nikomu automaticky neodošle.', publish: 'Kolega uvidí presne tento náhľad namiesto predchádzajúcich údajov. Odkaz zostane rovnaký.', renew: 'Pôvodný odkaz a otvorené prístupy prestanú fungovať. Vznikne nový odkaz; zverejnené údaje sa nezmenia. Táto akcia môže znovu otvoriť časovo vypršané odovzdanie.', extend: 'Odkaz zostane rovnaký. Predĺženie môže znovu sprístupniť časovo vypršané odovzdanie; zverejnené údaje sa nezmenia.', revoke: 'Odkaz prestane fungovať. Dôvod bude uložený v histórii.'
};
export function Handoffs({ draft, active, onBack }: {
  draft: HandoffDraft;
  active: boolean;
  onBack: () => void;
}) {
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot), scroll = useRef<ScrollView>(null);
  const [shareError, setShareError] = useState<string | null>(null), [expanded, setExpanded] = useState<string | null>(null), [sharing, setSharing] = useState(false);
  useEffect(() => {
    if (active) {
      draft.expire();
      void draft.refresh();
    }
    else
      draft.pause();
    return () => draft.pause();
  }, [active, draft]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next === 'active' && active) {
        draft.expire();
        void draft.refresh();
      }
      else
        draft.pause();
    });
    return () => sub.remove();
  }, [draft, active]);
  useEffect(() => {
    if (!state.link)
      return;
    const timer = setTimeout(() => draft.expire(), Math.min(2147483647, Math.max(0, Date.parse(state.link.expiresAt) - Date.now())));
    return () => clearTimeout(timer);
  }, [state.link, draft]);
  useEffect(() => {
    if (active && (state.error || ['saved', 'uncertain', 'conflict'].includes(state.status)))
      scroll.current?.scrollTo({ y: 0, animated: true });
  }, [active, state.status, state.error]);
  const receiptId = state.receipt?.commandId;
  useEffect(() => {
    if (active && receiptId)
      void draft.refresh();
  }, [active, receiptId, draft]);
  function share() {
    const url = draft.shareUrl();
    if (!url) {
      setShareError('Odkaz už nie je dostupný. Najprv získajte aktuálny odkaz.');
      return;
    }
    if (sharing)
      return;
    setSharing(true);
    setShareError(null);
    void Share.share(Platform.OS === 'android' ? { title: 'Odovzdanie prípadu', message: 'Odovzdanie prípadu: ' + url } : { title: 'Odovzdanie prípadu', message: 'Odovzdanie prípadu', url }).catch(error => {
      if (!(error instanceof Error && error.name === 'AbortError'))
        setShareError('Zdieľanie v tomto zariadení nie je dostupné alebo sa nepodarilo. Odkaz nebol automaticky odoslaný.');
    }).finally(() => setSharing(false));
  }
  const locked = state.status !== 'editing' || draft.busy, selected = state.selected;
  const preview = previewSnapshot(state);
  const choose = (action: Exclude<MobileHandoffInput['action'], 'recover'>, id?: string) => {
    if (draft.select(action, id)) {
      setShareError(null);
      scroll.current?.scrollTo({ y: 0, animated: true });
    }
  };
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView
      ref={scroll}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={styles.content}>

      <Text style={styles.heading}>Odovzdanie prípadu</Text>
      <Button
        label="Späť na prípad"
        secondary
        onPress={onBack}
        disabled={draft.busy} />

      {state.receipt && <Card>
        <Text accessibilityRole="alert" style={styles.subheading}>Odovzdanie uložené</Text>
        <Text style={styles.text}>{actions[state.receipt.action]} · potvrdená revízia {state.receipt.committedRevision}</Text>
        {state.receipt.link.status === 'unavailable' && <Text style={styles.text}>Uloženie je potvrdené, odkaz sa nepodarilo získať.</Text>}
        {state.status === 'saved' && state.pending && ['issue', 'renew'].includes(state.pending.action) && !state.link && <Button
          label="Znova získať pôvodný odkaz"
          secondary
          disabled={draft.busy}
          onPress={() => {
            void draft.reconcile();
          }} />}
      </Card>}

      {state.error && <ErrorNotice message={state.error} />}
      {shareError && <ErrorNotice message={shareError} />}

      {state.status === 'uncertain' && <Card>
        <Text style={styles.text}>Pôvodná požiadavka a jej náhľad sú zachované. Novú požiadavku zatiaľ nevytvárajte.</Text>
        <Button label="Overiť pôvodné odovzdanie" disabled={draft.busy} onPress={() => {
          void draft.reconcile();
        }} />
      </Card>}

      {state.status === 'conflict' && <Card>
        <Text style={styles.text}>Po obnovení porovnajte aktuálny náhľad s pôvodným. Vaše pokyny zostanú zachované.</Text>
        {state.canRebase && state.context && <>
          <Text style={styles.subheading}>Aktuálne údaje na porovnanie</Text>
          <HandoffSummary value={state.context.preview} />
        </>}
        <Button label="Použiť aktuálny náhľad a znova skontrolovať" disabled={!state.canRebase || state.loading} onPress={() => {
          draft.rebase();
        }} />
        <Button
          label="Zavrieť zamietnutú akciu"
          secondary
          disabled={!state.canRebase || state.loading}
          onPress={() => draft.cancel()} />
      </Card>}

      <Button
        label={state.loading ? 'Načítavam odovzdanie…' : 'Obnoviť stav odovzdania'}
        secondary
        disabled={state.loading || draft.busy}
        onPress={() => {
          void draft.refresh();
        }} />

      {state.link && <Card>
        <Text style={styles.text}>Odkaz je pripravený. Platí do {handoffTime(state.link.expiresAt)}.</Text>
        <Button label="Zdieľať odkaz" disabled={sharing || draft.busy} onPress={share} />
      </Card>}

      {state.loading && !state.context && <Loading />}

      {selected && <>
        <Text style={styles.subheading}>{actions[selected.action]}</Text>
        <Text style={styles.text}>{explanations[selected.action]}</Text>

        {selected.action === 'issue' && <>
          <Field
            label="Meno kolegu"
            value={state.input.recipientName}
            onChange={recipientName => draft.edit({ recipientName })}
            disabled={locked}
            maxLength={160} />
          <Field
            label="Telefón kolegu"
            value={state.input.recipientPhone}
            onChange={recipientPhone => draft.edit({ recipientPhone })}
            disabled={locked}
            maxLength={30} />
        </>}

        {['issue', 'publish'].includes(selected.action) && <>
          <Field
            label="Pokyny pre kolegu"
            value={state.input.instructions}
            onChange={instructions => draft.edit({ instructions })}
            disabled={locked}
            maxLength={2000}
            multiline />
          <Field
            label="Dohodnutý čas (RRRR-MM-DD HH:mm, čas zariadenia)"
            value={state.input.scheduledAt}
            onChange={scheduledAt => draft.edit({ scheduledAt })}
            disabled={locked}
            maxLength={16} />
          <Text style={styles.subheading}>Údaje, ktoré kolega uvidí</Text>
          {preview && <HandoffSummary value={preview} />}
        </>}

        {['issue', 'renew', 'extend'].includes(selected.action) && <Field
          label="Platnosť v hodinách (1–72)"
          value={state.input.hours}
          onChange={hours => draft.edit({ hours })}
          disabled={locked}
          maxLength={2} />}

        {selected.action === 'revoke' && <Field
          label="Dôvod zrušenia"
          value={state.input.comment}
          onChange={comment => draft.edit({ comment })}
          disabled={locked}
          maxLength={1000}
          multiline />}

        <Button label={state.status === 'saving' ? 'Ukladám odovzdanie…' : 'Potvrdiť: ' + actions[selected.action].toLowerCase()} disabled={locked} onPress={() => {
          void draft.submit();
        }} />

        {state.status === 'editing' && <Button label="Zavrieť rozpracovanú akciu" secondary onPress={() => draft.cancel()} />}
      </>}

      {state.context && <>
        <Text style={styles.subheading}>Odovzdania</Text>
        {!state.context.handoffs.some(h => ['offered', 'accepted', 'en_route', 'arrived'].includes(h.status) && Date.parse(h.expiresAt) > state.now) && <Button label="Nové odovzdanie" disabled={draft.busy || ['uncertain', 'conflict'].includes(state.status)} onPress={() => choose('issue')} />}

        {state.context.handoffs.length === 0 && <Text style={styles.muted}>Prípad zatiaľ nebol odovzdaný.</Text>}
        {state.context.handoffs.map(grant => <Card key={grant.id}>
          <Text style={styles.subheading}>{grant.recipientName}</Text>
          <Text style={styles.text}>{grant.recipientPhone} · {statuses[grant.status]}</Text>
          <Text style={styles.muted}>Revízia {grant.revision} · zverejnená verzia {grant.publishedVersion}</Text>
          <Text style={styles.text}>Platnosť: {handoffTime(grant.expiresAt)}</Text>
          <Text style={styles.muted}>Vytvorené: {handoffTime(grant.createdAt)} · {grant.createdBy || 'Dispečing'}{'\n'}Otvorené: {handoffTime(grant.openedAt)}{'\n'}Príchod: {handoffTime(grant.eta)}{'\n'}Zverejnené: {handoffTime(grant.publishedAt)}</Text>

          {grant.canRenew && <>
            <Button
              label="Zverejniť aktuálne údaje"
              secondary
              disabled={draft.busy || ['uncertain', 'conflict'].includes(state.status) || Date.parse(grant.expiresAt) <= state.now}
              onPress={() => choose('publish', grant.id)} />
            <Button
              label="Obnoviť odkaz"
              secondary
              disabled={draft.busy || ['uncertain', 'conflict'].includes(state.status)}
              onPress={() => choose('renew', grant.id)} />
            {state.context?.enhanced && <Button
              label="Predĺžiť platnosť"
              secondary
              disabled={draft.busy || ['uncertain', 'conflict'].includes(state.status)}
              onPress={() => choose('extend', grant.id)} />}
            <Button
              label="Zrušiť odovzdanie"
              secondary
              disabled={draft.busy || ['uncertain', 'conflict'].includes(state.status)}
              onPress={() => choose('revoke', grant.id)} />
          </>}

          {state.context?.enhanced && grant.recoverable && ['offered', 'accepted', 'en_route', 'arrived'].includes(grant.status) && Date.parse(grant.expiresAt) > state.now && <Button
            label={state.recovering ? 'Získavam odkaz…' : 'Získať aktuálny odkaz'}
            secondary
            disabled={state.recovering || draft.busy || ['uncertain', 'conflict'].includes(state.status)}
            onPress={() => {
              void draft.recover(grant.id);
            }} />}

          <Button label={expanded === grant.id ? 'Skryť údaje a históriu' : 'Zverejnené údaje a história'} secondary onPress={() => setExpanded(expanded === grant.id ? null : grant.id)} />
          {expanded === grant.id && <>
            {grant.published && <HandoffSummary value={grant.published} />}
            <Text style={styles.subheading}>História</Text>
            {grant.events.length === 0 && <Text style={styles.muted}>Bez udalostí.</Text>}
            {grant.events.map(event => <View key={event.id}>
              <Text style={styles.text}>{events[event.action]} · {event.actor}</Text>
              <Text style={styles.muted}>{handoffTime(event.createdAt)}</Text>
              {!!event.comment && <Text style={styles.text}>{event.comment}</Text>}
            </View>)}
          </>}
        </Card>)}
      </>}

    </ScrollView>
  </KeyboardAvoidingView>;
}
function Field({ label, value, onChange, disabled, maxLength, multiline }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  maxLength: number;
  multiline?: boolean;
}) {
  return <View>
    <Text style={styles.label}>{label}</Text>
    <TextInput
      accessibilityLabel={label}
      style={styles.input}
      value={value}
      onChangeText={onChange}
      editable={!disabled}
      maxLength={maxLength}
      multiline={multiline}
      autoCorrect={false} />
  </View>;
}
