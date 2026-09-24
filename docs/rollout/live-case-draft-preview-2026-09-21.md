# Živý náhľad nového prípadu

Pri vytváraní nového prípadu kolegovia doteraz videli iba meno autora. Po rozbalení „Zobraziť rozpracovaný prípad“ teraz uvidia jeho priebežne vypĺňané údaje. Návrh upravuje výhradne autor; náhľad nemá editačné ovládanie a server odmietne zápis iného používateľa. Uložené prípady si zachovávajú existujúci spôsob spolupráce.

## Správanie

- Autor zdieľa výber textových údajov formulára po potvrdení svojej relácie. Zmeny sa združujú približne po 700 ms; nikdy sa neodosielajú súbežne. Súbory, interné identifikátory a doklady z vyhľadávania vozidla nie sú súčasťou náhľadu.
- Rozbalený viditeľný náhľad načíta aktuálny stav každé 2 sekundy po dokončení predchádzajúcej požiadavky. Pri výpadku spomalí, označí staršie údaje a najneskôr po 15 sekundách bez overenia ich skryje. Skryté a zatvorené náhľady nečítajú. Zobrazuje sa čas poslednej zmeny.
- Vymazanie poľa sa prenesie tiež. Návrhy z viacerých kariet toho istého autora zostávajú oddelené. Po návrate z offline stavu alebo uspatia sa celý aktuálny návrh znova odošle až po overení relácie; poradie verzií zostáva zachované.
- Uloženie alebo zrušenie končí reláciu a odstráni jej náhľad. Expirovaný alebo neprístupný návrh sa nedá načítať. Fyzické čistenie expirovaných záznamov je obmedzené na 100 pri ďalšej platnej požiadavke; nevzniká scheduler.
- Náhľad nenahrádza „Uložiť kartu“. Rozpísaný formulár sa kvôli zdieľaniu nevytvára ako ostrý prípad. Pri prekročení limitu náhľadu (4 000 znakov na pole, 48 kB spolu) zostane formulár zachovaný a autor vidí upozornenie, že náhľad sa nepodarilo zdieľať.

## Dáta a aktivácia

Nová migrácia: `supabase/migrations/20261007110000_case_draft_preview.sql`. Pridáva dočasný obsah naviazaný na už existujúcu reláciu editora a samostatnú zabezpečenú databázovú funkciu. Obsah sa neposiela cez prítomnosť ani Realtime broadcast. Čítanie vyžaduje aktuálne oprávnenie dispečera v rovnakej organizácii; zapisuje iba vlastník živej relácie. Súbežné ukončenie a oneskorený zápis serializuje zámok relácie. Všetky odpovede HTTP sú `private, no-store`.

Migrácia sa testuje iba v izolovanom lokálnom PostgreSQL. Jej aplikovanie na Supabase `ifpaeegaesdmljfkdvcn` čaká na výslovný súhlas podľa AGENTS.md §7. Bez migrácie zostávajú existujúce prípady a prítomnosť funkčné; rozbalený náhľad oznámi, že ešte nie je dostupný. Aktivácia vedie cez pracovnú vetvu → Preview → dev → main; žiadne opätovné nasadenie starého zdroja ani zmena domén.

Telefonický runtime, provider, ovládače prijatia a zavesenia, konfigurácia a databázové tabuľky telefonovania sa nemenia.

## Overenie

Kontroly zahŕňajú plnú sadu Vitest/Node, typecheck, build, lint, nové izolované prehliadačové scenáre autora a kolegu, regresie existujúcej spolupráce a telefónnych ovládačov. SQL kontrakty preverujú oprávnenia, poradie verzií, oba smery súbehu publikovania a ukončenia, expiráciu/obnovenie a odobratie oprávnení počas čakajúcej požiadavky. Presné výsledky a snímky sú v `.context/case-draft-preview/` a súvisiacich lokálnych logoch. Reálne produkčné dáta, hovory ani migrácia sa pri týchto testoch nemenia.

Po aktivácii: dvaja používatelia otvoria Nástenku. Jeden začne nový prípad a vypĺňa meno/vozidlo/poznámku; druhý rozbalí jeho návrh a overí živý text vrátane vymazania. Druhý používateľ údaje nemôže editovať. Uloženie či zrušenie odstráni náhľad a neovplyvní rozpracovaný formulár kolegu.
