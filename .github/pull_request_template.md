## Kontrola pred merge

- [ ] Preview URL som otvoril(a) a skontroloval(a).
- [ ] Zmena neobsahuje nechcené DB migrácie, worker ani cron úpravy.
- [ ] Prípadné živé SMS, hovory alebo emaily boli výslovne autorizované pre dané prostredie a testovacie kontakty.

## Iba pri vydaní do produkcie

- Cesta: bežné vydanie cez TEST / schválený výber zmien / na výslovný pokyn rovno do produkcie.
- Rozsah vydania:
- TEST: https://test.dispecing.linkapomoci.sk
- Overený commit `dev`, alebo dôvod vynechania ručného TESTU:
- Čo bolo overené a čo zostáva neoverené:
- Výslovné schválenie vlastníka (pokyn alebo odkaz):
- Pri izolovanom/urgentnom vydaní: plán alebo PR na prenos `main` späť do `dev`.

- [ ] Zmena bola overená na uvedenom TEST commite, alebo vlastník výslovne požiadal o priame produkčné vydanie.
- [ ] Vlastník schválil celý obsah tohto vydania; PR neobsahuje ďalšie neschválené zmeny.
- [ ] Existujúci Vercel build prešiel. Až potom je možné merge a nasadenie na https://dispecing.linkapomoci.sk.

Po vydaní: produkčný commit a health; TEST commit; ktoré zmeny má len jedno prostredie; pri produkčnej oprave stav následného syncu. Postup: [release workflow](https://github.com/Alfopure/pomoc-motoristom-new/blob/dev/docs/operations/release-workflow.md).
