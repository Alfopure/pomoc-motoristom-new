## Kontrola pred merge

- [ ] Preview URL som otvoril(a) a skontroloval(a).
- [ ] Zmena neobsahuje nechcené DB migrácie, worker ani cron úpravy.
- [ ] Prípadné živé SMS, hovory alebo emaily boli výslovne autorizované pre dané prostredie a testovacie kontakty.

## Iba pri vydaní do produkcie (`dev -> main`)

- TEST: https://test.dispecing.linkapomoci.sk
- Overený commit `dev`:
- Čo bolo overené a čo si má vlastník vyskúšať:
- Výslovné schválenie vlastníka (pokyn alebo odkaz):

- [ ] TEST beží na uvedenom commite a zmena na ňom bola overená.
- [ ] Vlastník schválil celý obsah tohto vydania; PR neobsahuje ďalšie neschválené zmeny.
- [ ] Existujúci Vercel build prešiel. Až potom je možné merge a nasadenie na https://dispecing.linkapomoci.sk.
