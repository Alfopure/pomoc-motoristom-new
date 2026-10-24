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

Z čistého checkoutu aktuálneho `dev`, s Vercel tokenom iba v prostredí procesu,
sa vytvorí nový build **výhradne projektu `pomoc-motoristom-test`**:

```sh
vercel deploy --project prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk \
  --scope alfopures-projects --prod --yes --no-wait \
  --build-env LIVE_DELIVERY_QA=1 \
  --build-env LIVE_DELIVERY_QA_RUN_ID=<nove-uuid> \
  --build-env LIVE_DELIVERY_QA_EXPECTED_SHA=<aktualny-dev-sha>
```

`--prod` označuje Production target samostatného TEST projektu. Nepoužívajte
ho na produkčný dispatching projekt. Nepridávajte tieto prepínače do trvalých
projektových premenných. Neprepisujte systémové `VERCEL_*` hodnoty, aby prešli
kontroly. Ak CLI neposkytne skutočný Git ref/SHA, overenie skončí pred zápismi.
Bežný build bez explicitného opt-inu žiadne živé QA nespúšťa.

Pôvodný build gate (testy, typecheck, browser regresie, build) zostáva zachovaný.
Citlivé TEST kľúče používa iba build vo svojom prostredí; nevypisujú sa ani sa
neexportujú z Vercelu. Chromium dostáva obmedzené prostredie bez admin/provider
kľúčov. Browser blokuje externé služby, telefonovanie, websockety a všetky
zápisy okrem odovzdania vlastného skúšobného prípadu.

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

```sh
vercel deploy --project prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk \
  --scope alfopures-projects --prod --yes --no-wait \
  --build-env LIVE_DELIVERY_QA=1 \
  --build-env LIVE_DELIVERY_QA_MODE=cleanup \
  --build-env LIVE_DELIVERY_QA_RUN_ID=<povodne-uuid> \
  --build-env LIVE_DELIVERY_QA_EXPECTED_SHA=<aktualny-dev-sha> \
  --build-env LIVE_DELIVERY_QA_FIXTURE_SHA=<povodne-fixture-sha>
```

Cleanup je opakovateľný a neprehľadáva historické dáta podľa voľného prefixu.
Nepoužívajte historický deployment ani starý zdroj na obnovenie TESTu.

Oficiálne rozhrania: [Supabase createUser](https://supabase.com/docs/reference/javascript/auth-admin-createuser),
[Vercel deployment options](https://vercel.com/docs/cli/deploy).
