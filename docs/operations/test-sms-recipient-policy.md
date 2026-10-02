# Príjemcovia odchádzajúcich TEST SMS

## Schválený rozsah

Majiteľ 2. 10. 2026 po zobrazení chyby „Cieľové číslo nie je povolené (allowlist)“ výslovne požiadal o odstránenie tejto funkcionality na TESTe. Ide iba o príjemcov odchádzajúcich SMS. Nie je to autorizácia produkcie, zmien hlasových hovorov, emailov, provider zdrojov, automatického kontaktovania kopírovaných klientov alebo spustenia hromadných správ.

Serverová premenná `MOTORIST_TEST_SMS_ALLOW_ANY_RECIPIENT=true` umožní odchádzajúcu SMS na ľubovoľné platné E.164 číslo iba v existujúcom dedikovanom TEST projekte `pomoc-motoristom-test` (`prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk`), `dev` / Production, s kanonickým TEST pôvodom a Supabase `nzpnqdstvkfncflgqlny`. Default je `false`; iná hodnota, bežný Preview, Development, `main`, produkčný projekt alebo produkčná databáza výnimku neaktivujú.

Výnimka sa uplatňuje konzistentne pred vytvorením SMS pokusu v preflight aj pri skutočnom provider requeste. Pre SMS nevyžaduje členstvo v organizačnom `destination_allowlist` ani v presnom TEST zozname príjemcov. Neplatný formát, SIP cieľ alebo wildcard nie je povolený.

## Zachované ochrany

- Organizačný `destination_allowlist` sa nemení: naďalej platí pre hovory aj produkčné SMS.
- `MOTORIST_TEST_ALLOWED_NUMBERS` a `MOTORIST_TEST_FROM_NUMBERS` sa nemenia; hlasové a inbound pravidlá ostávajú rovnaké. Prázdna/neplatná konfigurácia TEST provider hranice naďalej zlyhá uzavreto.
- TEST messaging profile, overený odosielateľ, callback pôvod a presná deployment/databázová identita zostávajú povinné. Produkčné provider secrets ani zdroje sa nekopírujú.
- Env aj DB SMS kill switch, limit 20 SMS/minútu, autentifikácia, náhľad, explicitné odoslanie a idempotentný workflow zostávajú zachované.
- Samotné nasadenie neposiela SMS a nezakladá nové schedulery, workery ani listeners.

## Nasadenie a overenie

Zapnúť iba túto jednu nesekretnú premennú v Production target dedikovaného TEST projektu, nie v produkčnom projekte alebo vo všeobecnom Preview. Doručiť kód cez samostatný PR do aktuálneho `dev` s vlastným povinným Vercel gate. Po novom READY deploymente porovnať kanonický TEST health s presným deploymentom a commitom.

Regresné testy používajú syntetické čísla a zachytené provider requesty, nie živé správy. Overujú preflight aj send na číslo mimo pôvodného zoznamu, TEST sender/profile, neplatné čísla, fail-closed Preview/produkciu, nezmenené hlasové a inbound obmedzenia, kill switches a rate limit. Prihlásený TEST používateľ môže skúsiť vlastné zamýšľané číslo cez SMS formulár; build a mocked send nepreukazujú fyzické doručenie.

Táto zmena neodstraňuje obmedzenia operátora. Posledná zdokumentovaná konfigurácia TEST Telnyx messaging profile povoľovala iba Slovensko a denný limit 1 USD. Odstránenie aplikačného recipient allowlistu samo nepotvrdzuje SMS do Česka alebo iných krajín. Takéto doručenie treba osobitne overiť a prípadnú provider konfiguráciu riešiť v presnom TEST profile, nie v produkčnom alebo všeobecnom účte.

## Odmietnutá správa a provider destinácie

Majiteľ následne 2. 10. 2026 schválil bezpečný prístup k pôvodnému TEST Telnyx kľúču a povolenie všetkých destinácií iba v existujúcom TEST SMS profile. Nie je to autorizácia zmien produkcie, hlasových zdrojov, odosielateľa, callbacku, limitov ani hromadného odosielania. Pred zmenou overiť identitu TEST profilu, meniť iba `whitelisted_destinations` a následne načítať výsledok; dostupnosť jednotlivých krajín a odosielateľa naďalej určuje poskytovateľ. Autorizácia nie je dôkaz, že provider nastavenie už bolo zmenené alebo správa doručená.

Vercel `sensitive`/Secret premenné sú po uložení nečitateľné. Ak individuálne načítanie TEST `TELNYX_API_KEY` nevráti hodnotu, použiť iba legitímne dostupnú pôvodnú TEST kópiu alebo požiadať majiteľa o nastavenie destinácií v Telnyx portáli. Kľúč nevypisovať, neukladať do repozitára a nezískavať obchádzaním ochrany; nepoužiť produkčný kľúč ani zaviesť endpoint na výpis secrets. Pozri [Vercel Secret premenné](https://vercel.com/docs/environment-variables/sensitive-environment-variables) a [Telnyx aktualizáciu profilu](https://developers.telnyx.com/api-reference/profiles/update-a-messaging-profile).

Provider HTTP 401/403 je jednoznačné odmietnutie, nie nejasný výsledok odoslania. Workflow ho uloží ako `failed` / `send_failed`, vráti dôvod aj pri overení pôvodnej požiadavky a editor ho zobrazí. Až po takomto potvrdenom odmietnutí môže používateľ výslovne zvoliť „Napísať novú SMS“. Overenie pôvodného ID nikdy neposiela ďalšiu správu. Timeouty a provider 5xx zostávajú `send_unconfirmed`; editor neponúka novú SMS, aby zabránil duplikátom. [Telnyx chyba 40309](https://support.telnyx.com/en/articles/6505121-telnyx-messaging-error-codes) znamená nepovolenú cieľovú krajinu v messaging profile.

## Návrat

Nastaviť `MOTORIST_TEST_SMS_ALLOW_ANY_RECIPIENT=false` v tom istom TEST scope a vybuildiť aktuálny `dev` nanovo. Neredeplyovať historický deployment. Organizačný a presný TEST zoznam príjemcov sa potom opäť uplatnia bez databázovej migrácie.
