"use client";

import { useRef, useState } from "react";
import { Delete } from "lucide-react";
import { calculateExpression } from "./calculator";

export function CalculatorWidget() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [expression, setExpression] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  function calculate() {
    try { setResult(calculateExpression(expression).toLocaleString("sk-SK", { maximumFractionDigits: 12, useGrouping: false })); setNotice(null); }
    catch (error) { setResult(null); setNotice(error instanceof Error ? error.message : "Skontrolujte výraz."); }
  }
  function backspace() {
    const input = inputRef.current;
    const start = input?.selectionStart ?? expression.length;
    const end = input?.selectionEnd ?? start;
    const before = start === end ? Math.max(0, start - 1) : start;
    setExpression(expression.slice(0, before) + expression.slice(end));
    setResult(null); setNotice(null);
    requestAnimationFrame(() => { input?.focus({ preventScroll: true }); input?.setSelectionRange(before, before); });
  }
  async function copyResult() {
    if (result === null) return;
    try { await navigator.clipboard.writeText(result); setNotice("Výsledok skopírovaný."); }
    catch { setNotice("Kopírovanie nie je dostupné. Označte výsledok a skopírujte ho ručne."); }
  }
  return <form onSubmit={event => { event.preventDefault(); calculate(); }} className="calculator-widget space-y-3 p-3">
    <label className="block text-sm font-medium">Výpočet
      <input ref={inputRef} value={expression} onChange={event => { setExpression(event.target.value); setResult(null); setNotice(null); }} placeholder="(70 − 50) × 2 × 0,75" maxLength={300} className="mt-1 min-h-11 w-full rounded-lg border border-zinc-300 px-3 text-base" />
    </label>
    <div className="calculator-keypad grid grid-cols-4 gap-1">
      {["7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "0", ",", "(", ")", "+"].map(key => <button key={key} type="button" data-calculator-key={key} className="min-h-11 rounded-lg bg-zinc-100 text-base font-medium hover:bg-zinc-200" onClick={() => { setExpression(current => (current + key).slice(0, 300)); setResult(null); setNotice(null); }}>{key}</button>)}
      <button type="button" data-calculator-key="clear" className="col-span-2 min-h-11 rounded-lg text-sm hover:bg-zinc-100" onClick={() => { setExpression(""); setResult(null); setNotice(null); }}>Vymazať</button>
      <button type="submit" data-calculator-key="equals" className="min-h-11 rounded-lg bg-zinc-950 font-bold text-white">=</button>
      <button type="button" data-calculator-key="backspace" className="calculator-backspace hidden min-h-11 items-center justify-center rounded-lg" aria-label="Vymazať jeden znak alebo výber" disabled={!expression} onMouseDown={event => event.preventDefault()} onClick={backspace}><Delete size={19} /></button>
    </div>
    {result !== null && <div className="calculator-result flex flex-wrap items-center justify-between gap-2 rounded-lg bg-yellow-50 p-2"><output className="break-all text-xl font-semibold">{result}</output><button type="button" className="min-h-11 px-2 text-sm" onClick={() => void copyResult()}>Kopírovať</button></div>}
    {notice && <p role="status" className="text-sm text-zinc-700">{notice}</p>}
  </form>;
}
