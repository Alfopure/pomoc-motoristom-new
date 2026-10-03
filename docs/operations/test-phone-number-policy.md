# Bežné hovory a SMS v TESTe

Majiteľ 3. 10. 2026 výslovne požiadal, aby TEST nemal osobitné obmedzenie na jeho mobil alebo iné vopred zapísané telefóny. Samostatný TEST má umožňovať bežnú obsluhu hovorov podľa rovnakých organizačných a poskytovateľských pravidiel ako produkcia. Ide o zmenu TEST konfigurácie, nie o nasadenie do produkcie alebo spojenie databáz a telefónnych zdrojov.

## Režim bez zoznamu testerov

`MOTORIST_TEST_ALLOW_ANY_PHONE_NUMBER=true` platí výhradne pre overený projekt `prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk`, `dev` / Production, kanonický `https://test.dispecing.linkapomoci.sk` a TEST Supabase `nzpnqdstvkfncflgqlny`. Predvolená hodnota je `false`.

- Prichádzajúci hovor na vlastné TEST číslo v presnej TEST Call Control aplikácii nemusí pochádzať zo zoznamu testerov. Povolené je aj skryté číslo volajúceho.
- Odchádzajúce hovory, presmerovania a SMS nemusia mať konkrétny cieľ v `MOTORIST_TEST_ALLOWED_NUMBERS`. Formát odchádzajúceho telefónneho čísla zostáva platné E.164; SIP cieľ naďalej vyžaduje overenú TEST identitu.
- Prichádzajúce SMS môžu mať platného odosielateľa mimo zoznamu testerov, ale musia smerovať na vlastné TEST číslo a prejsť pôvodnými kontrolami podpisu a messaging profile. Nastavenie samo nepridáva číslu SMS podporu.
- Pri tomto režime `MOTORIST_TEST_ALLOWED_NUMBERS` nemusí byť vyplnené. `MOTORIST_TEST_FROM_NUMBERS` zostáva povinným presným zoznamom vlastných TEST čísel; aktuálne `+421232408774`.
- Bežná organizačná politika destinácií, rozpočty a kapacita sa týmto prepínačom neobchádzajú. Organizačná hlasová politika pri porovnaní 3. 10. povoľuje `SK` a `CZ` v produkcii; TEST sa nastavuje rovnako. Prázdny organizačný zoznam znamená zákaz všetkých destinácií, nie neobmedzenú prevádzku.

Existujúce `MOTORIST_TEST_SMS_ALLOW_ANY_RECIPIENT=true` ostáva samostatnou, už schválenou výnimkou pre odchádzajúce SMS vrátane organizačného filtra krajín. Zachovať aj povolené celosvetové destinácie v TEST messaging profile. Všeobecný telefónny prepínač túto SMS výnimku implicitne nezapína. Pozri [SMS recipient policy](test-sms-recipient-policy.md).

## Zdrojové a prevádzkové hranice

Zostávajú samostatné TEST linky, Call Control a messaging profile, interné browser credentials, podpisované webhooky na TEST doméne a overenie TEST pôvodu pri ovládaní hovorov, konferencií a nahrávok. Browser má vlastný vypnutý PSTN outbound profile; bežné hovory vytvára server cez aktívny TEST Call Control profil. Toto oddelenie nie je zoznamom povolených volajúcich.

Live gates, autentifikácia, validácia čísla, idempotencia a obvyklé organizačné limity zostávajú aktívne. Bežný pracovný Preview, lokálne prostredie, iný Vercel projekt alebo nesprávna databáza sa novým prepínačom nedajú aktivovať. Odstránenie zoznamu testerov nepovoľuje automaticky obvolať skopírované kontakty ani vykonať ich historické provider príkazy.

Pri nasadení porovnať iba telefónne prevádzkové polia TEST a produkcie. Produkciu čítať; aktualizovať iba príslušné TEST riadky/profily s kontrolou pôvodných hodnôt a auditom. Zachovať už schválené TEST SMS destinácie, TEST názvy, IDs, webhooky, odosielateľa a jedného webového operátora. Nepridávať dvojité zvonenie, workery ani cron.

## Overenie

Regresné testy majú prijímať neznáme aj skryté číslo volajúceho na vlastnej TEST linke, povoľovať platné odchádzajúce čísla mimo pôvodného zoznamu a súčasne odmietnuť cudzí provider zdroj, caller ID, SIP identitu, vypnutý live gate a nesprávny deployment. Overiť, že všeobecný telefónny režim neobíde organizačný SMS filter bez samostatnej SMS výnimky.

Po PR do `dev` overiť nový READY deployment, kanonické health endpointy, efektívnu organizačnú politiku a provider readback. Automatické testy používajú syntetické čísla; samotné nasadenie nevolá ani neposiela SMS. Reálny zvuk a doručenie sa preukazujú osobitným živým pokusom.
