"use client";

import { useId, useState } from "react";
import { ClipboardPaste, Download, FileText, WandSparkles } from "lucide-react";
import { caseTextFields, parseCaseText, type CaseTextField, type CaseTextValues } from "@/lib/case-text-import";

type Row = { key: CaseTextField; values: string[]; value: string; previous: string; checked: boolean };
export function CaseTextImport({ current, disabled, visible = true, onApply }: { visible?: boolean; current: CaseTextValues; disabled: boolean; onApply: (patch: Partial<CaseTextValues>) => void }) {
  const id = useId();
  const [source, setSource] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [notice, setNotice] = useState("");
  const selected = rows.filter(row => row.checked && row.value.trim() && row.value.trim() !== current[row.key]);
  const stale = selected.some(row => row.previous !== current[row.key]);
  function analyse() {
    const suggestions = parseCaseText(source);
    setRows(suggestions.map(row => ({ ...row, value: row.values[0], previous: current[row.key], checked: false })));
    setNotice(suggestions.length ? "Vyberte údaje, ktoré chcete vložiť. Existujúce hodnoty vidíte pri každom návrhu." : "Nenašli sa označené údaje. Doplňte napríklad Klient:, Telefón:, EČV: alebo Miesto:. Text zostáva zachovaný.");
  }
  return <details hidden={!visible} className="case-text-import" data-testid="case-text-import">
    <summary><span className="case-text-import-icon"><ClipboardPaste size={17} aria-hidden="true" /></span><span><strong>Údaje z textu</strong><small>Vložiť objednávku, SMS alebo prepis</small></span><FileText size={15} aria-hidden="true" /></summary>
    <div className="case-text-import-body">
      <label htmlFor={id}>Pôvodný text</label>
      <textarea id={id} value={source} maxLength={20_000} rows={5} placeholder={"Klient: Ján Novák\nTelefón: +421…\nEČV: …\nMiesto: …"} onChange={event => { setSource(event.target.value); setRows([]); setNotice(""); }} />
      <p>Rozpoznávajú sa označené riadky. Voľný text sa nevyhodnocuje pomocou AI. Miesto sa vloží ako adresa na overenie.</p>
      <p>Pôvodný text zostáva v otvorenej karte. Pred jej zatvorením si ho môžete stiahnuť na uchovanie.</p>
      <button type="button" className="case-text-analyse" disabled={!source.trim()} onClick={() => {
        const url = URL.createObjectURL(new Blob([source], { type: "text/plain;charset=utf-8" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = "podklad-pripadu.txt";
        anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }}><Download size={14} aria-hidden="true" />Stiahnuť pôvodný text</button>
      <button type="button" className="case-text-analyse" disabled={!source.trim() || disabled} onClick={analyse}><WandSparkles size={14} aria-hidden="true" />Navrhnúť údaje</button>
      {rows.length > 0 && <fieldset><legend>Návrhy na vloženie</legend>{rows.map(row => {
        const field = caseTextFields.find(field => field.key === row.key)!;
        return <div key={row.key} className="case-text-proposal">
          <label className="case-text-check"><input type="checkbox" checked={row.checked} disabled={disabled} onChange={event => setRows(old => old.map(item => item.key === row.key ? { ...item, checked: event.target.checked } : item))} />{field.label}</label>
          {row.values.length > 1 && <label>Rozdielne hodnoty v zdroji<select aria-label={`Vybrať návrh: ${field.label}`} value={row.value} onChange={event => setRows(old => old.map(item => item.key === row.key ? { ...item, value: event.target.value } : item))}>{row.values.map(value => <option key={value}>{value}</option>)}</select></label>}
          <input aria-label={`Navrhnutá hodnota: ${field.label}`} value={row.value} onChange={event => setRows(old => old.map(item => item.key === row.key ? { ...item, value: event.target.value } : item))} />
          <p className={current[row.key] && current[row.key] !== row.value ? "case-text-replacement" : ""}>{current[row.key] ? `Teraz: ${current[row.key]}` : "Pole je prázdne."}{current[row.key] && current[row.key] !== row.value ? " Výberom potvrdíte jeho nahradenie." : ""}</p>
        </div>;
      })}</fieldset>}
      {stale && <p role="alert">Údaje formulára sa medzitým zmenili. Znovu kliknite na Navrhnúť údaje a skontrolujte ich.</p>}
      {rows.length > 0 && <button type="button" className="case-text-apply" disabled={disabled || stale || !selected.length} onClick={() => {
        if (disabled || stale || !selected.length) return;
        onApply(Object.fromEntries(selected.map(row => [row.key, row.value.trim()])));
        setRows([]); setNotice(`Vložené polia: ${selected.length}. Použije sa bežné automatické uloženie prípadu. Pôvodný text zostáva tu.`);
      }}>Vložiť vybrané údaje ({selected.length})</button>}
      {notice && <p role="status">{notice}</p>}
    </div>
  </details>;
}
