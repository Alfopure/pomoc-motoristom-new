# Opravy latencie hovorov — 22. 9. 2026

Zmeny sa overujú na Preview s testovacím Supabase `nzpnqdstvkfncflgqlny`.
Živé hovory zostávajú v teste vypnuté. Produkčný release ide cez `dev` → `main`.
Testy s falošným providerom dokazujú správanie pri súbehu; nenahrádzajú meranie
skutočného zvonenia a zvuku po nasadení.

## E3–E4: zavesenie a ochrana čakárne

- Ukončovanie preskočí vetvu, pre ktorú už existuje prijatý provider `call.hangup`
  alebo úspešný príkaz hangup v journale. Syntetické `ended_at` samo nestačí.
- Ďalší kompenzačný pokus beží až vtedy, keď je podľa databázy splatný.
  Neznámy výsledok vytáčania zostáva povinnosťou pre ďalšiu obnovu.
- `call_hangup` z prehrávania/gatheru overenej zákazníckej vetvy uloží
  `metadata.customer_gone_at`. Sweep ani ručné prevzatie už nevytáčajú operátora.
  Skutočný hangup naďalej uzavrie vetvu a vytvorí prípadné spätné volanie.
- Sweep ustúpi nespracovanému hangupu presnej zákazníckej vetvy. Cron a webhook
  ho môžu v rámci rozpočtu spracovať; poll `calls/active` ho iba preskočí.
- Neskorý presný hangup opraví syntetický čas ukončenia bez opakovania príkazov.
  Koniec relácie zohľadňuje najneskorší koniec jej vetiev.

| Invariant | Mechanizmus | Dôkaz |
| --- | --- | --- |
| Každý príkaz patrí aktuálnemu držiteľovi lease | existujúci fenced journal a checkpoint | `termination-priority`, `projection-ownership` |
| Známy odchod zákazníka zastaví ponuky | marker, kontrola ledgera, odmietnutie pickup | `transitions`, `session-contention`, `ring-plan` |
| Neznámy dial sa nestratí | termination checkpoint a neskoršia obnova | `termination` |
| Presný koniec nemení obsluhu hovoru druhýkrát | korekcia iba bez pending effects | `transitions`, `terminal-hangup` |

Nové diagnostické kódy: `termination_legs_provider_ended` (preskočené ukončené
vetvy) a `termination_evidence_unavailable` (čítanie dôkazu zlyhalo, použila sa
pôvodná kompenzácia).

Obmedzenie: bez samostatne schválenej SQL zmeny zostáva krátke okno medzi
posledným rozhodnutím o vytáčaní a novým hangupom, ktorý ešte aplikácia neprijala.
Tieto opravy nesľubujú nulové vytáčanie po provider timestamp pri oneskorenom
doručení. Merajú sa zvlášť čas prijatia webhooku a čas jeho udalosti.

Rollback: revert príslušnej PR cez rovnaký dev-first postup. Marker v JSON
starší kód ignoruje; schéma, seed, rozvrh cronu a externé nastavenia sa nemenia.
