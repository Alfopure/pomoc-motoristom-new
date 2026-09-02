# Produkčný pilot dynamických pracovísk so statickým SIP

Tento režim je úzka, výslovne schválená výnimka pre testovanie dynamických
pracovísk vo Vercel Production s aktuálnymi statickými VIPTel SIP údajmi.
Neoslabuje režim `production_revocable`: ten naďalej vyžaduje reálne
odvolateľný credential provider a so statickým VIPTel zostáva zablokovaný.

## Akceptované obmedzenie

Generácia lease a aplikačné fence okamžite zablokujú starému prehliadaču naše
API, ale nedokážu na diaľku odvolať už zverejnené statické SIP heslo. Ak ho
niekto pozná a použije mimo aplikácie, definitívnym odvolaním je až zmena SIP
hesla vo VIPTel. Aplikačné obsadzovanie je dostupné každému prihlásenému
operátorovi s telefonickou rolou; autorizáciu naďalej vynucujú API route.

## Povinné podmienky

- additive workplace migrácia a bootstrap 20–23 sú dokončené a overené,
- `VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED=true`,
- `VIPTEL_WORKPLACE_HOTDESK_ENABLED=true` až počas aktívneho pilotu,
- `VIPTEL_WORKPLACE_DEPLOYMENT_STAGE=production`,
- runtime je skutočne Vercel Production (`VERCEL_ENV=production` nastavuje
  Vercel; Preview je vždy zablokovaný),
- `VIPTEL_WORKPLACE_HOTDESK_MODE=production_static_pilot`,
- `VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER=static_viptel`,
- výslovné potvrdenie je presne
  `VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT=I_ACCEPT_NON_REVOCABLE_STATIC_SIP_PILOT`,
- zostávajú zapnuté existujúce live-mutation, same-origin, ownership, lease a
  provider-snapshot ochrany.

Iná hodnota potvrdenia, iný credential provider, Preview, neznámy deployment
stage alebo vypnutý runtime/claims pilot bezpečne zablokujú. Profilový
allowlist sa v tomto režime nepoužíva. Potvrdenie nie je heslo; je to zámerne
presná poistka proti náhodnému zapnutiu režimu.

## Pracovné miesto v rade

Obsadenie voľného alebo bezpečne potvrdeného offline pracovného miesta nemení
členstvo klapky v rade. Výslovne potvrdený `production_static_pilot` dovoľuje
každému oprávnenému operátorovi aj odchod alebo prechod zo svojho miesta v rade 601–603 bez
`controlled_probe` env, evidence auditu a časového okna. Toto je vedomá
produkčná testovacia výnimka; `trusted_test` a `production_revocable` sa tým
nemenia.

Každý pokus naďalej vyžaduje čerstvý VIPTel provider snapshot a blokuje
nejednoznačnú klapku, pripojený telefón, zvonenie alebo aktívny hovor, `inUse`,
nezhodné členstvo v rade, pending príkazy, súbežnú operáciu a stratenú lease.
Nevyžaduje však samostatný nemenný approval audit, fallback reference ani
kontrolované probe okno. `VIPTEL_WORKPLACE_QUEUE_*` hodnoty preto pre tento
režim ponechať prázdne; ich prítomnosť nesmie vytvárať falošný dojem, že sú
runtime autoritou pilotu.

## Zapnutie a kontrola

1. Nechať claims vypnuté a overiť migráciu, bootstrap, nulové rozpracované
   operácie a aktuálny VIPTel snapshot.
2. Nastaviť všetky povinné hodnoty naraz. `VIPTEL_WORKPLACE_QUEUE_*` hodnoty
   pre tento režim nenastavovať.
3. Nasadiť najskôr s `VIPTEL_WORKPLACE_HOTDESK_ENABLED=false`; overiť, že
   runtime vie bezpečne čítať existujúce leases, ale nový claim odmieta.
4. Claims zapnúť iba pre dohodnutý pilot a overiť prihláseného operátora každej
   podporovanej telefonickej roly.
5. Otestovať claim, automatické pripojenie, prichádzajúci a odchádzajúci hovor.
   Potom otestovať prechod aj odchod z vlastného queued source; obe operácie
   musia stále prejsť čerstvým VIPTel idle proofom.

## Ukončenie a incident

Najprv nastaviť `VIPTEL_WORKPLACE_HOTDESK_ENABLED=false`. Runtime ponechať
zapnutý, kým sa aktívne leases a operácie bezpečne dokončia alebo uvoľnia.
Potom odstrániť acknowledgement a vrátiť mód na `disabled`.
Runtime vypnúť až po auditovanom stave nula aktívnych leases a nula
rozpracovaných operácií.

Pri podozrení na použitie statického SIP hesla mimo aktuálneho vlastníka
okamžite vypnúť claims, ukončiť pilot a rotovať dotknuté SIP heslo vo VIPTel.
Samotné vypnutie aplikačného gate už vydané statické SIP heslo neodvolá.
