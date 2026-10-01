# Rozšírené odovzdanie prípadu — TEST prebratie

Majiteľ 1. 10. 2026 schválil implementáciu a vydanie iba na [kanonický TEST](https://test.dispecing.linkapomoci.sk). Produkcia čaká na jeho osobné výslovné schválenie. Pred prácou bolo koordináciou potvrdené dokončenie druhého workspace na `dev` `2e2d3c6`, TEST deployment `dpl_PS5baSGukWXFwPAuPqbCqFEcGQFS`; nový vývoj vychádza z tohto `dev`, nie zo starého `main`.

## Správanie

- Nové odovzdanie uchováva token iba ako hash a autentifikovane šifrovanú obálku. Tlačidlo **Získať rovnaký odkaz** ho po reloade znovu vydá oprávnenému dispečerovi; nemení grant ani platnosť a neposiela SMS.
- **Predĺžiť platnosť bez zmeny odkazu** zachová token, údaje, stav a generáciu. Predĺženie expirovaného rozpracovaného grantu vyžaduje potvrdenie. Dokončené, odmietnuté a zrušené granty neotvorí.
- **Zneplatniť a vytvoriť nový odkaz** je samostatná potvrdená bezpečnostná rotácia. Pôvodný link a jeho sessions prestanú fungovať. Existujúci SMS koncept sa automaticky neprepíše.
- Staršie hash-only odkazy sa automaticky nemenia a ďalej platia. Ich tajomstvo nemožno spätne obnoviť; panel to vysvetlí a ponúkne iba explicitnú rotáciu.
- Zdieľaná karta obsahuje internú a asistenčnú referenciu, odstavené auto a jeho technické obmedzenia, overené priradené náhradné auto alebo jasný stav, trasu a samostatné pristavenie náhradného auta, kontakt, stručnú poruchu, osoby, prístup, termín, autora a relevantné časy. Nepriradené auto sa neodhaduje; odťahovka sa nikdy neoznačí za náhradné auto. Oficiálny kontakt dispečingu bez overenej organizačnej konfigurácie zostáva vynechaný.
- Náhľad je pevný allowlist a fingerprint vrátane nových zdrojov. Existujúci verejný snapshot sa doplní až cez **Zverejniť tento výber údajov**. VIN, interné poznámky, ceny, poistné nároky, prílohy ani nahrávky sa nezdieľajú.
- Časy sa zobrazujú v `Europe/Bratislava`; prvý súvisiaci hovor pochádza iba z prepojených inbound hovorov rovnakej organizácie. Vytvorenie odkazu nepredstiera odoslanie SMS.

## Konfigurácia a kompatibilita

Nová aditívna migrácia: `supabase/migrations/20261009100000_external_case_handoff_expansion.sql`. Starú handoff migráciu neprepisuje a neobsahuje seed ani backfill. Zachováva staré hash-only granty, verejnú session ochranu a kompatibilitu starej aplikácie s novou schémou.

Serverové premenné (žiadne `NEXT_PUBLIC_*`):

| Premenná | Význam |
| --- | --- |
| `MOTORIST_HANDOFF_V3_ENABLED` | Explicitné `true` aktivuje obnoviteľné vydávanie, retrieval a predĺženie. Default je vypnuté. |
| `MOTORIST_HANDOFF_KEY_ID` | Identifikátor aktívneho vydávacieho kľúča. |
| `MOTORIST_HANDOFF_KEYS` | JSON mapa ID → base64 32-bajtového serverového AES kľúča. Hodnoty nepatria do Git, logov ani release dôkazov. |

TEST a produkcia musia mať nezávislé kľúče. Kľúčová rotácia zachová staré verzie potrebné na dešifrovanie platných grantov. Vypnutie gate neinvaliduje vydané verejné odkazy. Chýbajúci alebo nesprávny kľúč bezpečne zablokuje nové vydanie/obnovu bez zásahu do hash-overovaných starých linkov. URL a kryptografický kontext sú viazané na organizáciu, prípad, grant, generáciu, hash a pôvod odkazu; znovuzískanie v inom TEST deploymente nemení pôvodnú doménu.

## Lokálne overenie

- Vitest: 5 474 prešlo, 2 preskočené podľa existujúcej konfigurácie; vrátane 51 cielených serverových/kryptografických kontrol.
- Node regression suite: 58 prešlo, 1 existujúca preskočená kontrola.
- PostgreSQL: 36 scenárov na jednorazovej loopback fixture, vrátane recovery/replay, scope, legacy, predĺženia, rotácie a allowlistu.
- Playwright: 32 fixture scenárov so zachytenými HTTP requestmi, vrátane reloadu/rovnakej URL, stratenej issue odpovede, SMS bez send a mobilnej rozšírenej karty.
- Typecheck, cielený ESLint a build s explicitnou TEST DB identitou prešli.

Lokálny pnpm 11 pri inštalácii narazil na existujúci neschválený build script `@sentry/cli`; závislosti boli nainštalované, automatický konfiguračný artefakt bol odstránený a overenie prebehlo cez lokálne binárky a existujúci target guard. Nastavenie pnpm ani Vercel build gate sa kvôli tomu nemení. Hosted Preview gate je samostatná povinná kontrola pred merge.

## Nasadenie a obmedzenia

Vzdialená migrácia, Preview gate, PR do `dev` a skutočné TEST správanie ešte vyžadujú konkrétny preberací záznam; lokálne výsledky ich nenahrádzajú. Produkčné ani retired projekty sa nesmú meniť. Toto vydanie nevykonáva živé SMS, fleet refresh ani telefonické provider operácie.
