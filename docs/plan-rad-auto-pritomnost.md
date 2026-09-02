# Plán: Auto‑prítomnosť v rade + pokrytie operátorov (call distribution)

> Future-work spec pre samostatný workspace. Stavia na queue vrstve, ktorá je už
> v `main` (PR #20): browser webphone (app‑wide), zjednotený prichádzajúci popup
> so Zdvihnúť, „Moja klapka" výber, a ovládanie radu z appky (panel „Rad":
> Prihlásiť/Pauza/Odhlásiť, reálni členovia, „X čaká"). Odbočiť z aktuálneho `main`.

## Context (prečo)

VIPTel rad sám smeruje hovor na voľného člena (obsadených/pauznutých preskočí; ak
sú všetci obsadení, hovor čaká). Aby „vždy je niekto pripravený zdvihnúť" reálne
platilo, treba doriešiť dve veci:

1. **Manuálne prihlasovanie + zvonenie do prázdna.** Operátor sa musí ručne
   prihlásiť do radu, a keď mu spadne web (zavrie notebook), jeho klapka ostane v
   rade → rad zvoní na mŕtvej klapke a zdržuje hovor.
2. **Žiadna viditeľnosť pokrytia.** Nevidno, koľko operátorov je reálne voľných,
   ani upozornenie keď hovor čaká a nikto nie je voľný.

**Cieľ:** keď zákazník zavolá, hovor vždy dôjde na reálne pripraveného operátora.
Telefón pri zapnutí automaticky pridá operátora do radu, pri odchode ho odoberie,
a appka ukazuje pokrytie + alertuje keď treba ďalšieho.

## Závislosti / štart
- Odbočiť z `main` (queue API + `QueuePanel` tam už sú).
- Reálny rad vo VIPTeli: „Test" id `500` (overené). Pre ostré hovory treba
  jednorazovo nasmerovať zákaznícke číslo na rad (VIPTel‑side, mimo tohto kódu).

## Rozsah

### V rozsahu
1. **Auto‑prítomnosť** — telefón connect → pridať do radu; disconnect/zavretie → odobrať.
2. **Indikátor pokrytia** — počet voľných operátorov + alert keď „čaká" a 0 voľných.
3. (Voliteľné) jemný zvuk/notifikácia pri čakajúcom hovore bez voľného operátora.

### Mimo rozsahu (poznámky, nie kód)
- Ring stratégia radu (ringall / leastrecent) = VIPTel nastavenie radu.
- Smerovanie zákazníckeho čísla na rad = VIPTel‑side.
- Server‑side TTL/heartbeat na úplne spoľahlivé odobranie po páde (viď Riziká).

## Implementácia

Točí sa okolo `src/components/dispatch/DispatchConsole.tsx`, kde už žije webphone
hook a queue stav. Znovupoužiť, nepridávať paralelné.

### 1. Auto‑prítomnosť (DispatchConsole.tsx)
Existujúce, na ktorých stavať:
- `browserWebphone` (`useViptelBrowserWebphone`) — `isRegistered`, `registrationStatus`, `callStatus`.
- `selectedWebphoneExtension` (vybraná klapka operátora).
- `queueId` (= `queues[0]?.id`, teraz „500"), `queueStatus`.
- `onQueueAction(action)` — POST na `/api/telephony/queues/agent` (`add|remove|pause|unpause`).

Pridať efekt „auto‑join/leave":
- `isRegistered === true` && klapka nastavená && operátor **ešte nie je členom**
  (`queueStatus.members`) && nebol manuálne odhlásený → add. Guard cez `useRef`
  (reaguj len na prechody, nie každý render/poll).
- `isRegistered` → `false` (odpojenie) → remove jeho klapky.
- Rešpektovať **manuálne** Odhlásiť/Pauza (drž `manuallyLeftRef`), nech auto‑join
  nepretláča voľbu „som preč".
- **NEodoberať počas hovoru** (`callStatus === "in_call"`): remove až pri reálnom disconnecte.
- Pri zmene `selectedWebphoneExtension`: odobrať starú klapku, pridať novú.

Zatvorenie okna (best‑effort remove):
- `pagehide`/`beforeunload` → `navigator.sendBeacon("/api/telephony/queues/agent", blob)`
  s JSON `{queue, extension, action:"remove"}` (Blob `application/json`).

**Lint pozor (react‑compiler pravidlá tohto repa):**
- Žiadny synchrónny `setState` v efekte. Fetch/POST efekty cez **lokálnu async
  funkciu vnútri efektu** (vzor existujúceho `/api/telephony/calls/active` pollu v
  DispatchConsole), nie externý `useCallback`.
- `localStorage` cez lazy `useState(() => ...)` s `typeof window` guardom, nie v efekte.
- Ref do JSX posielať ako prop do child (vzor `RemoteAudio` v `webphone-ui.tsx`).

### 2. Indikátor pokrytia + alert (`QueuePanel` v CallCenterModule.tsx)
`QueuePanel` už dostáva `status` (members + waitingCalls). Doplniť:
- Voľní = členovia kde `!paused && !inUse`. Zobraziť „Voľní: N / M".
- `waitingCalls > 0 && voľní === 0` → výrazný alert banner („Čaká hovor — žiadny
  voľný operátor, treba ďalšieho") + voliteľne krátky zvuk (prehrať na hrane prechodu).
- Ideálne ukázať pokrytie/alert aj mimo Call centra (odznak v hlavičke DispatchConsole),
  keďže telefón je app‑wide.

### Kritické súbory
- `src/components/dispatch/DispatchConsole.tsx` — auto‑join/leave efekt, pagehide remove, (príp. odznak pokrytia v hlavičke).
- `src/components/dispatch/CallCenterModule.tsx` — `QueuePanel`: voľní/alert.
- Bez zmien backendu: `/api/telephony/queues`, `/api/telephony/queues/agent`,
  `setQueueAgent` v `src/lib/integrations/viptel/client.ts` už stačia.

## Edge cases
- Operátor na hovore → ostáva člen (rad preskočí), neodoberať.
- Manuálne Odhlásiť/Pauza nesmie auto‑join pretlačiť.
- Tá istá klapka na dvoch PC → konflikt; v UI ukázať varovanie ak je klapka „in_use" iným.
- sendBeacon pri páde nemusí dôjsť → krátko môže ostať mŕtvy člen (mitigácia v Rizikách).

## Verifikácia (end‑to‑end)
1. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` — zelené.
2. **Auto‑join:** dve okná/PC, rôzne klapky (11, 12), pripoj telefón → obaja sa
   sami objavia v rade (over `GET /api/telephony/queues` + panel „Rad").
3. **Auto‑leave:** zavri okno → klapka do pár sekúnd zmizne z radu.
4. **Manuálne:** Odhlásiť → zostaň mimo aj po refreshi (kým sa nepripojíš/Prihlásiš).
5. **Pokrytie/alert:** člen na hovore/pauza + iný nie je voľný + hovor čaká → alert.
6. Zápis do radu overený (add klapka 11 → members `[11,10]`, remove → `[10]`).
   Nasadiť na Vercel prod a overiť naživo.

## Riziká
- **Spoľahlivé odobranie po páde**: sendBeacon je best‑effort. Neskôr server‑side
  „heartbeat/TTL" (bez pingu sa po N sek odoberie) alebo cez webphone `onServerDisconnect`.
- **Loop/duplicitné volania**: auto‑join/leave strážiť ref‑mi, reagovať len na prechody.
