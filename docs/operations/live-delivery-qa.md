# Prihlásené overenie odovzdania na TESTe

`scripts/qa/live-delivery-handoff.mjs` overuje bežné webové prihlásenie,
výber pristavovača, pridelenie, privátny mobilný zoznam, prevzatie a opakovanie
príkazu, cestu, syntetickú polohu, príchod a dokončenie. Dokončenie musí skryť
údaje klienta aj mapový odkaz a zastaviť tracker. Neoveruje fyzický telefón,
doručenie push, pohyb GPS na pozadí ani telefonovanie.

## Spustenie

Najskôr prejde pracovná vetva existujúcim Preview a PR do `dev`. Počkajte na
READY deployment dedikovaného TESTu a overte jeho Git SHA cez Vercel metadáta
a `/api/health/live`. QA vyžaduje rovnaký commit aj na kanonickej adrese.

Nový build vzniká z Git zdroja **výhradne projektu `pomoc-motoristom-test`**.
Samotný `vercel deploy` z checkoutu má síce Git metadáta, ale pri overení
neposkytol systémové Git premenné potrebné existujúcim kontrolám. Nevypĺňajte
ich ručne. Použite Git source request s presným aktuálnym SHA a jednorazovými
build premennými. Vercel token zostáva iba v prostredí CLI procesu.

Do lokálneho, necommitovaného JSON súboru pripravte nasledujúce telo; oba SHA
nahraďte rovnakým aktuálnym `dev` commitom, UUID je pre každý beh nové:

```json
{
  "name": "pomoc-motoristom-test",
  "project": "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
  "target": "production",
  "gitSource": {
    "type": "github", "repoId": 1354589389,
    "ref": "dev", "sha": "<aktualny-dev-sha>"
  },
  "build": { "env": {
    "LIVE_DELIVERY_QA": "1",
    "LIVE_DELIVERY_QA_RUN_ID": "<nove-uuid>",
    "LIVE_DELIVERY_QA_EXPECTED_SHA": "<aktualny-dev-sha>"
  } }
}
```

```sh
vercel api '/v13/deployments?forceNew=1' --method POST \
  --scope alfopures-projects --input .context/live-delivery-qa-request.json --raw
```

`target: production` označuje target samostatného TEST projektu. Nepoužívajte
produkčný dispatching projekt. Nepridávajte QA prepínače do trvalých projektových
premenných. Neprepisujte systémové `VERCEL_*` hodnoty, aby prešli kontroly.
Chýbajúci skutočný Git ref/SHA zastaví overenie pred zápismi.
Bežný build bez explicitného opt-inu žiadne živé QA nespúšťa.

Pole `build.env` používa [oficiálny Vercel CLI](https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/commands/deploy/index.ts#L1463),
aktuálna verejná OpenAPI schéma ho však neuvádza. Git kombinácia bola prijatá
a build klonoval presné `dev` SHA; samotné prijatie requestu nepreukazuje
vykonanie QA. Rozhodujú výsledky a cleanup v build logu.

Pôvodný build gate (testy, typecheck, browser regresie, build) zostáva zachovaný.
Citlivé TEST kľúče používa iba build vo svojom prostredí; nevypisujú sa ani sa
neexportujú z Vercelu. Chromium dostáva obmedzené prostredie bez admin/provider
kľúčov. Browser blokuje externé služby, telefonovanie, websockety a všetky
zápisy okrem odovzdania vlastného skúšobného prípadu. Výslovne povoľuje aj
autentifikovaný **čítací POST** `/api/cases/live` s telom `versions`; tým sa
potvrdzuje platný prístup k zoznamu prípadov. Bez neho aplikácia správne skryje
pracovné údaje. API actor stále pochádza z bežnej cookie session.

Chromium musí mať zapnutú webovú bezpečnosť: jeho serverless predvoľba
`--disable-web-security` sa odstraňuje. S týmto argumentom browser neposiela
`Origin` ani pri bežnom POST a správna CSRF ochrana odovzdanie odmietne.

## Účty, dáta a obnova

Admin klient pripraví tri nové potvrdené Auth účty, jeden dispečerský profil,
dve členstvá pristavovačov a vlastný kontakt, vozidlo a prípad. Nevysiela pozvánky,
e-maily, SMS ani push; skúšobné účty nemajú zariadenia. Samotné odovzdanie robí
bežný webový dispečer cez cookies a kroky pristavovača používajú bežné JWT.
Nevzniká migrácia, grant, verejný QA endpoint, worker ani nový cron.

ID sa odvodzujú z UUID behu. Účty obsahujú serverovú provenienciu; riadky majú
presné vlastné ID, organizáciu a značky. Cleanup najskôr overí vlastníctvo a
deaktivuje účty, potom zruší známe sessions, vymaže prípad (vrátane nadväzujúcich
handoff dát), kontakt, vozidlo, členstvá, profil a Auth účty. Bežný audit zostáva.
Signál alebo časový limit zastaví ďalšie kroky, počká na práve vykonávaný zápis
a hlavný tok cez `finally` spustí cleanup. Násilné zabitie buildu alebo stratená
odpoveď zápisu môžu vyžadovať samostatnú obnovu. Úspešný výsledok vyžaduje `deliveryQa: complete`
aj `cleanup-complete`; samotné READY nepotvrdzuje tieto skúšky.

Pri `cleanup-required` alebo prerušenom builde použite **aktuálny** čistý `dev`
checkout, rovnaké UUID a pôvodné SHA fixture. Nové SHA identifikuje vykonávaný
kód, pôvodné SHA identifikuje výhradne odstraňované fixture:

```json
{
  "LIVE_DELIVERY_QA": "1",
  "LIVE_DELIVERY_QA_MODE": "cleanup",
  "LIVE_DELIVERY_QA_RUN_ID": "<povodne-uuid>",
  "LIVE_DELIVERY_QA_EXPECTED_SHA": "<aktualny-dev-sha>",
  "LIVE_DELIVERY_QA_FIXTURE_SHA": "<povodne-fixture-sha>"
}
```

Tieto hodnoty vložte do `build.env` rovnakého Git source requestu; jeho
`gitSource.sha` je aktuálny `dev`, nie pôvodné fixture SHA.

Cleanup je opakovateľný a neprehľadáva historické dáta podľa voľného prefixu.
Nepoužívajte historický deployment ani starý zdroj na obnovenie TESTu.

Oficiálne rozhrania: [Supabase createUser](https://supabase.com/docs/reference/javascript/auth-admin-createuser),
[Vercel deployment options](https://vercel.com/docs/cli/deploy).
