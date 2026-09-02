# Dispečing: handoff migrácie a Hetzner nasadenia

Aktualizované: 22. júla 2026.

Tento dokument je zdroj pravdy pre pokračovanie po archivácii vetvy `Alfopure/oprav-zaplavu-emailov`. Neobsahuje heslá, tokeny, osobné údaje ani názvy Storage objektov.

## Výsledná architektúra

- Autoritatívna databáza, Auth a Storage: Supabase Frankfurt `sjcsrygkkmersoczpunh`.
- Pôvodný Supabase `jcwbiulwuwyrnmzjjbgr`: zmrazený, nezmazaný, iba ako návratová poistka.
- Finálny web, API, worker a VIPTel listener: Hetzner `195.201.36.90`.
- Produkčný hostname: `dispecing.linkapomoci.sk`.
- Vývojový hostname: `dev.dispecing.linkapomoci.sk`; patrí na Vercel preview, nie na produkčný Hetzner runtime.
- Vercel momentálne zostáva dočasná funkčná produkcia proti Frankfurt Supabase. Vypne sa až po stabilnom Hetzner cutoveri.
- Mac mini ani GitHub Actions nie sú navrhnuté ako runtime závislosť.
- SWHouse zostáva vypnutý až do dodania a overenia samostatných produkčných credentials.

## Čo je hotové

- DB, Auth, Storage a konfigurácia boli migrované zo source do Frankfurt targetu. Source nebol zmazaný.
- Source bol pri poslednej čerstvej kontrole database-default read-only a mal 0 aktívnych cronov.
- Target bol zapisovateľný, mal 0 aktívnych cronov a 0 z 11 job controls zapnutých.
- Vercel aplikácia bola prepnutá na Frankfurt target a stabilizačné kontroly webu, Auth, Data API a Storage prešli.
- Commander, WebDispecink a ostatné podporované one-shot integrácie už prešli kontrolovanými testami proti Frankfurtu. Ich automatické plánovanie zostáva vypnuté.
- VIPTel autentifikácia, prichádzajúci aj odchádzajúci hovor a CDR/WebSocket reconciliation boli overené proti Frankfurtu. Produkčný Hetzner listener zostáva vypnutý.
- Hardened runtime a activation chain boli zlúčené v PR #63 až #70.
- Minimálna target-authority gate bola zlúčená v PR #71; oddelené source/target read-only evidence bolo doplnené v PR #72.
- GitHub Actions pri posledných PR nespustili testovacie kroky pre billing/spending-limit blok. Nie je to test failure; povinné testy prešli lokálne.

## Pripravený release

> **Neaktivovať tento starý release.** Bol vytvorený pre už zrušený hostname
> `app.dispecing.linkapomoci.sk`. Pred Hetzner cutoverom treba z aktuálneho
> `main` vytvoriť nový release, runtime a čerstvú gate pre
> `dispecing.linkapomoci.sk`.

- Verzia: `hetzner-20260717T135957Z`.
- Zdrojový commit: `49b14b0ca086c956416d9c369941873f08290eca`.
- Image ID: `sha256:b054ac5825d2acc709260b70477c895b5020db143583428b47834a2ee57d349d`.
- Platforma: `linux/amd64`.
- Scheduler v manifeste: vypnutý.
- Lokálne prešli lint, typecheck, 291 Vitest testov, 196 Node testov a produkčný web/worker/one-shot/VIPTel build.
- Všetkých 17 release checksumov sedí.
- Release a vypnutý runtime sú staged na Hetzneri:
  - `/opt/motorist/releases/hetzner-20260717T135957Z`
  - `/opt/motorist/probes/hetzner-20260717T135957Z/runtime`
- `--probe-candidate-only` prešiel na loopback porte. Kandidát sa odstránil; pri post-checku bolo 0 produkčných kontajnerov, neexistoval `current` pointer ani cutover receipt.

Private probe gate z 17. júla je expirovaná a je iba auditný dôkaz. Nikdy ju nepoužiť na cutover. Installer pre produkčný cutover vyžaduje novú gate mladšiu než 5 minút.

## Aktuálna externá brána

Autoritatívny DNS momentálne dedí wildcard:

```text
dispecing.linkapomoci.sk -> 37.9.169.25
dev.dispecing.linkapomoci.sk -> 37.9.169.25
```

K zóne bol udelený samostatný DNS prístup. Záznamy meniť až po priradení
hostname k pripravenému cieľu:

```text
dev.dispecing: projektový Vercel CNAME pre preview
dispecing: najprv projektový Vercel CNAME; pri koordinovanom Hetzner cutoveri A -> 195.201.36.90
TTL: 600
```

Existujúci wildcard ani ostatné záznamy zóny nemaž. Pre presný názov nesmie
zostať konfliktný A, AAAA alebo CNAME záznam.

## Minimálny postup po zmene DNS

1. Autoritatívne aj cez verejný resolver potvrdiť, že `dispecing.linkapomoci.sk` smeruje výhradne na `195.201.36.90`.
2. Dočasne povoliť iba aktuálnu administrátorskú `/32` na SSH:

   ```sh
   node .context/migration/actions/temporary-hetzner-ssh.mjs allow --confirm-temporary-current-ip
   ```

3. Read-only vytvoriť nový aggregate evidence:
   - source cez source-scoped Supabase Management API s `read_only:true`,
   - target cez `supabase_dispatch_prod` MCP,
   - bez PII, rows, secretov alebo raw logov,
   - source musí byť frozen + 0 cronov,
   - target writable + 0 cronov + presne 11 controls + 0 enabled.
4. Spustiť `deploy/bin/create-target-authority-gate.py` nad presným release, runtime a build contractom. Gate musí prejsť Auth, Data API, Storage, checksums, image/runtime target-only a freshness.
5. Nahrať gate pod nový, predtým neexistujúci názov. Starú probe gate neprepisovať.
6. Na Hetzneri spustiť presný release:

   ```sh
   /opt/motorist/releases/<novy-release>/bin/install-release.sh \
     /opt/motorist/releases/<novy-release> \
     /opt/motorist/probes/<novy-release>/runtime \
     /cesta/k/novej-cutover-gate.json \
     --install-after-dns-cutover
   ```

7. Overiť HTTPS, `/api/health/live`, päťkrát `/api/health/ready`, presný image ID, prihlásenie, jednu DB operáciu a jeden Storage read. Potvrdiť 0 aktívnych cronov a 0/11 jobov.
8. Monitorovať minimálne 30 minút. Pri zlyhaní odstrániť nový stack podľa installer rollbacku; source nezapínať a neposielať zápisy do oboch projektov.

## Aktivácia integrácií

Web cutover môže prebehnúť so schedulerom a listenerom vypnutým. Pred ich aktiváciou však treba:

1. Na presnom novom release zopakovať požadovaný one-shot chain a vytvoriť nové append-only receipts.
2. Získať genuine v2 VIPTel listener receipt viazaný na presný release; overiť prichádzajúci, odchádzajúci, connected a reconnected stav.
3. Zapínať cez `activate-after-cutover.sh` jednotlivo: notifikácie, WebDispecink, Commander, nahrávky, prepisy a VIPTel listener.
4. Po každom kroku skontrolovať Healthchecks a agregované výsledky. SWHouse nezapínať.
5. Po stabilnej prevádzke vypnúť Vercel, zopakovať web/Auth/Data/Storage/telephony kontroly a otestovať reštart Hetznera.

## Povinné bezpečnostné hranice

- Source nemaž, neodmrazuj a nepoužívaj na nové zápisy bez samostatného rozhodnutia používateľa.
- Nepoužívaj demo seed ani `deploy/supabase/bootstrap-runtime.mjs`.
- Nepoužívaj starú alebo expirovanú gate a neprepisuj append-only receipts.
- Joby a listener nechaj vypnuté, kým neprejde ich exact-release activation gate.
- Neposielaj source URL, credentials, PII alebo raw Storage inventár do image, Git histórie, logov ani handoff dokumentov.
- Tajné runtime súbory zostávajú iba v gitignored `.context` archivovaného Harare workspace. Ak nie sú dostupné, znovu ich zachyť interaktívne; nekopíruj ich do repozitára.
- Po práci vždy odstráň dočasnú SSH `/32`, relay a dočasné DB roly a over presnú obnovu firewallu.

## Lokálne súkromné dôkazy

Tieto cesty sú gitignored a existujú v archivovanom Harare workspace:

- `.context/migration/validation/target-authority-hetzner-20260717T135957Z-probe.json`
- `.context/migration/validation/aggregate-evidence-20260717T141618Z.json`
- `.context/migration/firewall-receipts/ssh-restored-20260717T141801Z.json`
- `.context/migration/wip-protection/20260717T134823Z/`
- `.context/clean-release/49b14b0/deploy/releases/hetzner-20260717T135957Z/`
- `.context/migration/runtime-hetzner-20260717T135957Z/`

Dočasný SSH `/32` bol po private probe odstránený a pôvodný firewall bol obnovený presne.

## Archivovaný rozpracovaný kód

Rozpracovaný v12 continuity/watermark a one-shot transition evidence kód nie je súčasťou potrebného produkčného cutoveru. Bol zachovaný oddelene, nesmie sa automaticky mergnúť do `main` a musí prejsť samostatným návrhom a review, ak sa k nemu tím niekedy vráti.

Archívny Git tag a commit sú uvedené v záverečnej archivačnej správe tejto vetvy.
