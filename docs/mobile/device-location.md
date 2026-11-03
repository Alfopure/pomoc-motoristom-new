# Poloha telefónu pri výbere miesta prípadu

Rozšírenie mobilných prípadov z 15. 10. 2026. V novom aj upravovanom
prípade možno použiť aktuálny telefón ako návrh miesta vyzdvihnutia alebo
cieľa. Použite ho iba vtedy, keď ste na príslušnom mieste: poloha telefónu
dispečera nie je poloha zákazníka.

## Postup

1. Pri mieste ťuknúť na **Na mape** (VoiceOver: „Vybrať miesto na mape: …“).
2. Stlačiť **Použiť polohu telefónu** a podľa potreby povoliť polohu počas
   používania aplikácie. Samotné otvorenie mapy polohu nežiada.
3. Skontrolovať zobrazenú približnú presnosť a vybrať
   **Zobraziť polohu na mape**. Táto akcia pripraví čerstvý bod na kontrolu.
4. Overiť miesto na mape, prípadne ho upraviť, a použiť existujúce
   potvrdenie miesta do formulára.
5. Prípad uložiť samostatným tlačidlom. Pri úprave zostáva aj potvrdenie
   nahradenia pôvodného miesta a kontrola súbežnej zmeny kolegu.

Zisťovanie možno zrušiť. Odmietnuté alebo zablokované oprávnenie,
vypnutá poloha, nedostupný modul alebo neúspešné zisťovanie sa zobrazia
ako chyba; zostáva ručný výber mapy alebo adresy. Pokus sa po návrate
do aplikácie sám neopakuje. Pri zablokovanom oprávnení sa povolenie mení
v nastaveniach telefónu; aplikácia nepredstiera jeho udelenie.

## Čerstvosť a presnosť

Zisťovanie má limit 25 sekúnd vrátane žiadosti o oprávnenie. Vyžaduje
konečné súradnice v platnom rozsahu, známu nezápornú presnosť najviac
1000 metrov a meranie nie staršie než 15 sekúnd; tolerancia času zariadenia
do budúcnosti je päť sekúnd. Skutočný bod `0,0` sa nemení na chybu.
Neplatné, staré a nepresné merania sa nepoužijú ako náhradný výsledok.
Čerstvosť sa znovu skontroluje pri vedomom zobrazení bodu na mape.

Zobrazená presnosť je údaj systému, nie záruka správneho miesta zásahu.
Aj prijatý približný bod musí dispečer skontrolovať. Po vypnutí presnej
polohy môže systém vracať príliš hrubú polohu; vtedy použite mapu ručne.
Nežiada sa posledná uložená poloha a nevymýšľa sa adresa zo starého prípadu.
Počiatočný GPS návrh používa súradnicový popis a existujúci typ
`approximate`. Overenú ulicu môže používateľ následne vybrať na mape.

Presnosť a čas merania sú dočasná informácia tejto relácie. Existujúce
uloženie miesta prijíma bod, popis, adresu a zdroj; táto etapa nemení
databázový model ani netvrdí, že ukladá novú GPS metadátovú stopu.
Prijatá zákaznícka poloha `client_gps` zostáva odlišným údajom.

## Životný cyklus a oprávnenia

Žiadosť vzniká iba na pokyn používateľa. Pri zatvorení výberu, zmene
záložky/účtu alebo odchode do pozadia sa pokus zruší a oneskorený výsledok
sa nepoužije. Zruší sa aj dostupná registrácia priebežného merania;
registrácia, ktorá príde až po zrušení, sa okamžite uvoľní. Prvý prijatý
bod meranie ukončí. Nepridáva sa sledovanie, geofencing, úloha na pozadí
ani nový cron alebo serverový pracovník.

iOS systémová otázka na povolenie môže dočasne označiť aplikáciu ako
neaktívnu. Obrazovka rozlišuje túto čakajúcu žiadosť od skrytej záložky
a skutočného pozadia. Meranie a zobrazenie nového bodu čakajú na aktívne
popredie; existujúce pravidlá načítania údajov a uloženia sa neuvoľňujú.
Nový bod otvára novú inštanciu mapy s novým nonce. Starý rámec nemôže
potvrdiť výber pre novú mapu, iný prípad alebo iný účet.

Používa sa `expo-location` 57.0.21 z Expo Go SDK 57, iba foreground
permission a štandardné meranie počas otvorenej obrazovky. Vlastná
konfigurácia potláča nepotrebné iOS Always a motion popisy a pozadie/
lokalizačnú foreground službu nepovoľuje. Android modul môže obsahovať
neexportovanú triedu služby; prítomnosť triedy nie je aktivovaním služby.
Existujúce iPhone hlasové režimy audio/voip zostávajú zachované.
[Oficiálna dokumentácia Expo Location](https://docs.expo.dev/versions/latest/sdk/location/).

Expo Go už príslušný natívny modul obsahuje. Vlastné staršie binárky
neprijmú túto funkciu cez Expo Go aktualizáciu; potrebujú neskorší nový
build. Ich OTA zostáva vypnuté. Prehliadačový náhľad a vlastná zostava bez
modulu ponúknu jasnú chybu pri požiadavke a zachovajú ručné zadanie.

## Overenie

Jednotkové skúšky overujú aj čakanie na oprávnenie, staré/neplatné meranie,
vypršanie času, zrušenie a neskoré registrácie. Konfiguračná skúška spúšťa
skutočný nainštalovaný Expo plugin introspektívne pre obe platformy;
nevytvára novú binárku. Namontovaný simulovaný náhľad musí označiť
náhradu natívneho polohového rozhrania, siete, účtu a úložiska ako MOCK.

Fyzická skúška musí osobitne potvrdiť systémovú otázku, skutočnú polohu
a presnosť, návrat do aplikácie a kontrolu bodu na mape. Export, obsah
publikovaného balíka ani simulácia túto akceptáciu nenahrádzajú.
Pri skúške používajte vlastné označené TEST prípady. Táto funkcia
nepotrebuje novú SQL migráciu, telefónne zdroje ani Apple podpis pre Expo Go.
