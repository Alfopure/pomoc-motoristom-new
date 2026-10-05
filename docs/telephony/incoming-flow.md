# Postup prichádzajúceho hovoru

Nový editor ukladá samostatný postup do `motorist_telephony_lines.metadata.incoming_flow`. Samotné nasadenie ani migrácie nemenia uložené smerovanie. Pôvodná linka používa svoj plán, kým správca výslovne nepripraví a neuloží nový postup. Existujúce hovory pokračujú podľa zmrazeného plánu.

## Správanie

- Ľudia v jednom kroku zvonia naraz; kroky sa vykonávajú postupne.
- **Aplikácia** skúsi pripojený web a pripojenú nainštalovanú mobilnú aplikáciu. Nepripojené zariadenie sa vynechá; toto nepridáva prebudenie uspatej aplikácie na pozadí.
- **Osobné číslo** je bežný telefónny hovor na číslo zobrazené pri človeku. Číslo sa ukladá iba do daného kroku; predvolené číslo operátora sa nemení.
- Obe možnosti môžu byť zapnuté. Každé zariadenie má vlastný pokus a identitu príkazu; operátor zdieľa jedinú rezerváciu hovoru. Prvý platný prijatý hovor zastaví ostatné ponuky.
- Čakáreň čaká na ručné prevzatie. Hudba a existujúce krátke gather intervaly zachovávajú absolútny časový limit; po ňom nasleduje ďalší krok. Nepoužíva sa nový scheduler.
- Opakovanie vykoná vybrané predchádzajúce kroky zvonenia znovu, s novými indexmi a identitami. Neopakuje čakáreň ani ďalšie opakovanie.
- Záložné číslo je samostatný časovaný krok. Ukončenie nastane až po prejdení postupu.
- Naďalej platia otváracie hodiny, pauzy, zastupovanie pozastaveného operátora a limity súbežných zariadení.

Formát verzie 1 povoľuje 20 zdrojových krokov, 20 ľudí v kroku, zvonenie 5–120 sekúnd, čakanie 1–60 minút a 1–5 dodatočných opakovaní. Po rozvinutí môže mať najviac 100 krokov a dve hodiny. Organizácia môže mať nižší limit súbežných zariadení.

## Uloženie a kompatibilita

`PUT /api/telephony/config/incoming-flow` je same-origin a manager/admin API. Ukladá len zmenené linky v jednej transakcii cez `motorist_save_incoming_flow`: kontroluje routing version, coherent snapshot a pôvodný postup každej linky. Ostatné metadata ostávajú zachované. Stratená HTTP odpoveď sa v editore overí novým čítaním, neposiela sa slepo druhý zápis.

Hlasové menu a návratové linky používajú pôvodný editor. Pôvodné zdieľané skupiny ani plány sa automaticky neprevádzajú. Po uložení nového postupu API odmietne staré zmeny režimu/plánu/IVR, ktoré by pôsobili ako funkčné, ale postup by ich ignoroval.

## Nasadenie

Táto zmena je pripravená pre `dev` a dedikovaný TEST, Supabase `nzpnqdstvkfncflgqlny`, Vercel `pomoc-motoristom-test`, https://test.dispecing.linkapomoci.sk. Produkčné nasadenie nie je súčasťou tohto kroku.

Potrebné migrácie, iba po výslovnom schválení cieľovej databázy:

1. `20261010110000_unified_incoming_flow.sql`: konzistentné čítanie a transakčné uloženie postupov; žiadne prepísanie uložených liniek.
2. `20261010120000_mobile_app_ring_endpoints.sql`: nullable rozlíšenie web/mobil v pokusoch a dve upravené unique indexy. NULL zachováva pôvodný web. Ochrana pred rezerváciou operátora dvoma rôznymi hovormi ostáva.

Schopnosť editora `unifiedIncomingFlow` sa aktivuje až po oboch migráciách. Preview nesmie prevádzkovať stabilnú TEST telefóniu. Pred prechodom na TEST overiť aktuálny `dev`, migrácie, stav deploymentu a identitu projektu; potom skontrolovať `/api/health/live`, `/api/health/ready` a prihlásené čítanie nastavení. Telefónne skúšky a fyzické prijatie hovoru ostávajú samostatnou akceptáciou používateľa.

Lokálne overenie: `tests/postgres/unified-incoming-flow.py`, nové modelové/API/runtime testy a `e2e/incoming-flow.spec.ts`; pôvodný editor naďalej pokrýva `e2e/incoming-routing.spec.ts`.
