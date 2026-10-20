import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, KeyboardAvoidingView, Platform, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useAndroidBack } from "../lib/use-android-back";
import { useShellBack } from "../shell/back";
import type { MobileHandoffInput } from '../../../src/lib/mobile-api';
import { Button, Card, ErrorNotice, Loading, styles } from '../ui';
import { DetailHeader, InfoRow, Tag, type TagTone } from '../design/detail';
import { Field, FormSection, formLayout } from '../design/form';
import { Group, Row, SectionHeader } from '../design/list';
import { palette, space, type } from '../design/tokens';
import { formatNumber } from '../lib/display';
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
  const back = () => { if (!draft.busy) onBack(); };
  useAndroidBack(active, back, draft.busy);
  useShellBack(active, 'Prípad', back, draft.busy);
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
  const busyOrBlocked = draft.busy || ['uncertain', 'conflict'].includes(state.status);
  const live = (grant: { status: string; expiresAt: string }) => ['offered', 'accepted', 'en_route', 'arrived'].includes(grant.status) && Date.parse(grant.expiresAt) > state.now;
  const canStart = state.context ? !state.context.handoffs.some(live) : false;
  // A saved action is done: the receipt above says so, and its form would only block the next one.
  const showForm = Boolean(selected) && state.status !== 'saved';
  const preview0 = state.context?.preview;
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView
      ref={scroll}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={formLayout.content}>
      <DetailHeader title="Odovzdanie prípadu" subtitle={preview0 ? [preview0.caseNumber, preview0.action].filter(Boolean).join(' · ') : null}
        meta={state.context ? 'Overené ' + handoffTime(state.context.checkedAt) : null} />

      <View style={formLayout.notices}>
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
          {!state.canRebase && <Button label={state.loading ? 'Načítavam odovzdanie…' : 'Obnoviť stav odovzdania'} secondary disabled={state.loading || draft.busy} onPress={() => {
            void draft.refresh();
          }} />}
          <Button label="Použiť aktuálny náhľad a znova skontrolovať" disabled={!state.canRebase || state.loading} onPress={() => {
            draft.rebase();
          }} />
          <Button
            label="Zavrieť zamietnutú akciu"
            secondary
            disabled={!state.canRebase || state.loading}
            onPress={() => draft.cancel()} />
        </Card>}
        {state.loading && !state.context && <Loading label="Načítavam odovzdanie…" />}
      </View>
      {state.status === 'conflict' && state.canRebase && state.context && <>
        <SectionHeader title="Aktuálne údaje na porovnanie" />
        <HandoffSummary value={state.context.preview} />
      </>}

      {state.link && <>
        <FormSection title="Odkaz pre kolegu" footer="Odkaz sa nikomu neposiela automaticky. Zdieľajte ho priamo kolegovi.">
          <InfoRow first label="Platí do" value={handoffTime(state.link.expiresAt)} />
        </FormSection>
        <View style={formLayout.actions}><Button primary label="Zdieľať odkaz" disabled={sharing || draft.busy} onPress={share} /></View>
      </>}

      {showForm && selected && <>
        <FormSection title={actions[selected.action]} footer={explanations[selected.action]}>
          {selected.action === 'issue' && <Field key="name" label="Meno kolegu" value={state.input.recipientName} onChangeText={recipientName => draft.edit({ recipientName })}
            editable={!locked} maxLength={160} autoCorrect={false} textContentType="name" placeholder="Meno a priezvisko" />}
          {selected.action === 'issue' && <Field key="phone" label="Telefón kolegu" value={state.input.recipientPhone} onChangeText={recipientPhone => draft.edit({ recipientPhone })}
            editable={!locked} maxLength={30} autoCorrect={false} keyboardType="phone-pad" textContentType="telephoneNumber" placeholder="+421 …" />}
          {['issue', 'publish'].includes(selected.action) && <Field key="instructions" label="Pokyny pre kolegu" value={state.input.instructions} onChangeText={instructions => draft.edit({ instructions })}
            editable={!locked} maxLength={2000} multiline autoCorrect={false} />}
          {['issue', 'publish'].includes(selected.action) && <Field key="time" label="Dohodnutý čas" hint="RRRR-MM-DD HH:mm, čas zariadenia" value={state.input.scheduledAt}
            onChangeText={scheduledAt => draft.edit({ scheduledAt })} editable={!locked} maxLength={16} autoCorrect={false} placeholder="napr. 2026-10-21 14:30" />}
          {['issue', 'renew', 'extend'].includes(selected.action) && <Field key="hours" label="Platnosť v hodinách" hint="1 až 72 hodín" value={state.input.hours}
            onChangeText={hours => draft.edit({ hours })} editable={!locked} maxLength={2} keyboardType="number-pad" />}
          {selected.action === 'revoke' && <Field key="comment" label="Dôvod zrušenia" value={state.input.comment} onChangeText={comment => draft.edit({ comment })}
            editable={!locked} maxLength={1000} multiline autoCorrect={false} />}
        </FormSection>
        {['issue', 'publish'].includes(selected.action) && preview && <>
          <SectionHeader title="Údaje, ktoré kolega uvidí" />
          <HandoffSummary value={preview} />
        </>}
        <View style={formLayout.actions}>
          <Button primary label={state.status === 'saving' ? 'Ukladám odovzdanie…' : 'Potvrdiť: ' + actions[selected.action].toLowerCase()} disabled={locked} onPress={() => {
            void draft.submit();
          }} />
          {state.status === 'editing' && <Button label="Zavrieť rozpracovanú akciu" secondary onPress={() => draft.cancel()} />}
        </View>
      </>}

      {state.context && <>
        <SectionHeader title="Odovzdania" detail={state.context.handoffs.length ? String(state.context.handoffs.length) : null} />
        {canStart && !showForm && <View style={s.start}><Button primary label="Nové odovzdanie" disabled={busyOrBlocked} onPress={() => choose('issue')} /></View>}
        {state.context.handoffs.length === 0 && <Text style={s.empty}>Prípad zatiaľ nebol odovzdaný.</Text>}
        {state.context.handoffs.map(grant => <View key={grant.id} style={s.grant}>
          <Group>
            <Row first title={grant.recipientName} subtitle={grant.recipientPhone ? formatNumber(grant.recipientPhone) : null}
              trailing={<Tag text={statuses[grant.status] ?? grant.status} tone={statusTones[grant.status] ?? 'gray'} />} />
            <InfoRow label="Platnosť" value={handoffTime(grant.expiresAt)} />
            <InfoRow label="Vytvorené" value={handoffTime(grant.createdAt)} detail={grant.createdBy || 'Dispečing'} />
            <InfoRow label="Otvorené" value={grant.openedAt ? handoffTime(grant.openedAt) : null} empty="Zatiaľ neotvorené" />
            <InfoRow label="Príchod" value={grant.eta ? handoffTime(grant.eta) : null} empty="Neuvedený" />
            <InfoRow label="Zverejnené údaje" value={grant.publishedAt ? handoffTime(grant.publishedAt) : null} detail={'Verzia ' + grant.publishedVersion + ' · revízia ' + grant.revision} />
            {grant.canRenew && <Row title="Zverejniť aktuálne údaje" tone="link" disabled={busyOrBlocked || Date.parse(grant.expiresAt) <= state.now} onPress={() => choose('publish', grant.id)} />}
            {grant.canRenew && <Row title="Obnoviť odkaz" tone="link" disabled={busyOrBlocked} onPress={() => choose('renew', grant.id)} />}
            {grant.canRenew && state.context?.enhanced && <Row title="Predĺžiť platnosť" tone="link" disabled={busyOrBlocked} onPress={() => choose('extend', grant.id)} />}
            {state.context?.enhanced && grant.recoverable && live(grant) && <Row title={state.recovering ? 'Získavam odkaz…' : 'Získať aktuálny odkaz'} tone="link"
              disabled={state.recovering || busyOrBlocked} onPress={() => {
                void draft.recover(grant.id);
              }} />}
            {grant.canRenew && <Row title="Zrušiť odovzdanie" tone="danger" disabled={busyOrBlocked} onPress={() => choose('revoke', grant.id)} />}
            <Row title={expanded === grant.id ? 'Skryť údaje a históriu' : 'Zverejnené údaje a história'} tone="link"
              accessibilityLabel={(expanded === grant.id ? 'Skryť' : 'Zobraziť') + ' zverejnené údaje a históriu odovzdania pre ' + grant.recipientName}
              onPress={() => setExpanded(expanded === grant.id ? null : grant.id)} trailing={<Text style={s.chevron}>{expanded === grant.id ? '⌃' : '›'}</Text>} />
          </Group>
          {expanded === grant.id && <>
            {grant.published && <>
              <SectionHeader title="Zverejnené údaje" />
              <HandoffSummary value={grant.published} />
            </>}
            <SectionHeader title="História" />
            <Group>
              {grant.events.length === 0 ? <InfoRow first label="Udalosti" value={null} empty="Bez udalostí" />
                : grant.events.map((event, index) => <InfoRow key={event.id} first={index === 0} label={handoffTime(event.createdAt)}
                  value={(events[event.action] ?? event.action) + ' · ' + event.actor} detail={event.comment || null} />)}
            </Group>
          </>}
        </View>)}
      </>}

      <View style={formLayout.actions}>
        <Button
          label={state.loading ? 'Načítavam odovzdanie…' : 'Obnoviť stav odovzdania'}
          secondary
          disabled={state.loading || draft.busy}
          onPress={() => {
            void draft.refresh();
          }} />
      </View>
    </ScrollView>
  </KeyboardAvoidingView>;
}
const statusTones: Record<string, TagTone> = {
  offered: 'orange', accepted: 'green', en_route: 'green', arrived: 'green', completed: 'gray', rejected: 'red', cancelled: 'gray', expired: 'gray'
};
const s = StyleSheet.create({
  start: { paddingHorizontal: space.l, paddingBottom: space.s },
  empty: { ...type.subhead, color: palette.secondaryLabel, paddingHorizontal: 20 },
  grant: { marginBottom: space.m },
  chevron: { fontSize: 20, color: palette.tertiaryLabel },
});
