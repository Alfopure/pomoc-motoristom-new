'use client';
import { useCallback, useEffect, useState } from 'react';
import { partnerContactTimeLabel, partnerFollowupStatusLabels, partnerPeriod, partnerWorkStatusLabels, type PartnerFollowupCase, type PartnerFollowupStats, type PartnerPortalData } from '@/domain/partners';

const control='rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950';
const when=(value:string|null)=>value?new Date(value).toLocaleString('sk-SK',{timeZone:'Europe/Bratislava'}):'';
const day=(value:string)=>new Date(value).toLocaleDateString('sk-SK',{timeZone:'Europe/Bratislava'});
export function vehicleLabel(v:PartnerFollowupCase['vehicle']){const name=[v.make,v.model].filter(Boolean).join(' ');return [name,v.plate].filter(Boolean).join(' · ')||'Vozidlo neuvedené';}
export function PartnerFollowupStatsView({stats}:{stats:PartnerFollowupStats}){
 return <div className="space-y-1"><dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">{([['Prípady',stats.cases],['Poistné udalosti',stats.insuranceEvents],['Prevzaté',stats.taken],['Klient kontaktovaný',stats.contacted]] as const).map(([label,value])=><div key={label} className="rounded border bg-zinc-50 p-2"><dt className="text-zinc-600">{label}</dt><dd className="text-lg font-semibold">{value}</dd></div>)}<div className="col-span-2 rounded border bg-zinc-50 p-2 sm:col-span-1"><dt className="text-zinc-600">Čas do kontaktu</dt><dd className="font-semibold">{partnerContactTimeLabel(stats)}</dd></div></dl>
 <p className="text-xs text-zinc-600">Prípady podľa dátumu založenia. Čas do kontaktu meria od označenia poistnej udalosti po záznam kontaktu, iba keď sú známe oba časy.</p></div>;
}
type Action='take'|'contacted'|'note';
export function PartnerPortalCases(){
 const [period,setPeriod]=useState(()=>{const p=partnerPeriod(null,null)!;return {from:p.fromDate,to:p.toDate};});
 const [onlyNew,setOnlyNew]=useState(false);const [data,setData]=useState<PartnerPortalData|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState('');const [notes,setNotes]=useState<Record<string,string>>({});
 // An unconfirmed command keeps its ID and body; the same button only re-sends it.
 const [pending,setPending]=useState<Record<string,{id:string;body:string}>>({});
 const valid=Boolean(partnerPeriod(period.from,period.to));
 const load=useCallback(async()=>{if(!partnerPeriod(period.from,period.to))return;try{const response=await fetch(`/api/partners/portal?from=${period.from}&to=${period.to}`,{cache:'no-store'});const value=await response.json();if(!response.ok)throw new Error(value.error);setData(value);}catch(e){setError(e instanceof Error?e.message:'Prípady nie sú dostupné.');}},[period]);
 useEffect(()=>{void load();},[load]);
 async function send(c:PartnerFollowupCase,action:Action){
  const key=`${c.caseId}:${action}`;const intent=pending[key]??{id:crypto.randomUUID(),body:JSON.stringify({action,caseId:c.caseId,...(action==='note'?{body:(notes[c.caseId]??'').trim()}:{expectedRevision:c.revision})})};
  setPending(p=>({...p,[key]:intent}));
  setBusy(key);setError('');
  try{
   const response=await fetch('/api/partners/portal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...JSON.parse(intent.body),commandId:intent.id})});const value=await response.json().catch(()=>({}));
   if(response.ok||(response.status<500&&response.status!==408&&response.status!==429))setPending(p=>{const next={...p};delete next[key];return next;});
   if(!response.ok)throw new Error(response.status===409?'Stav sa medzitým zmenil. Zoznam je obnovený, skontrolujte ho.':value.error||'Výsledok nie je potvrdený. Zopakujte rovnaký príkaz.');
   if(action==='note')setNotes(n=>({...n,[c.caseId]:''}));
  }catch(e){setError(e instanceof Error?e.message:'Výsledok nie je potvrdený. Zopakujte rovnaký príkaz.');}
  finally{setBusy('');await load();}
 }
 const button=(c:PartnerFollowupCase,action:Action,label:string,disabled=false)=>{const unconfirmed=Boolean(pending[`${c.caseId}:${action}`]);return <button type="button" className={`${control} font-semibold disabled:opacity-50`} disabled={Boolean(busy)||disabled&&!unconfirmed} onClick={()=>void send(c,action)}>{unconfirmed?`Overiť pôvodný príkaz: ${label}`:label}</button>;};
 const cases=(data?.cases??[]).filter(c=>!onlyNew||c.insuranceEvent&&c.status==='new');
 return <section className="space-y-4" aria-labelledby="partner-cases">
  <div className="flex flex-wrap items-center gap-3"><h2 id="partner-cases" className="text-xl font-semibold">Moje prípady</h2>{data?<button type="button" onClick={()=>setOnlyNew(v=>!v)} aria-pressed={onlyNew} className={`rounded-full px-3 py-1 text-sm font-semibold ${data.newInsurance?'bg-red-600 text-white':'bg-zinc-100 text-zinc-700'}`}>Nové poistné udalosti: {data.newInsurance}{onlyNew?' · zobrazené iba nové':''}</button>:null}</div>
  <div className="flex flex-wrap items-end gap-3"><label className="grid gap-1 text-sm">Od<input type="date" className={control} value={period.from} onChange={e=>setPeriod(p=>({...p,from:e.target.value}))}/></label><label className="grid gap-1 text-sm">Do<input type="date" className={control} value={period.to} onChange={e=>setPeriod(p=>({...p,to:e.target.value}))}/></label>{!valid?<p role="alert" className="text-sm text-red-700">Zvoľte platné obdobie (najviac 400 dní).</p>:null}</div>
  {error?<p role="alert" className="text-sm text-red-700">{error}</p>:null}
  {!data?<p>Načítavam prípady…</p>:<><PartnerFollowupStatsView stats={data.stats}/>
  {cases.length===0?<p className="text-sm">V zvolenom období nemáte prípad.</p>:cases.map(c=><article key={c.caseId} className={`space-y-2 rounded-lg border p-4 ${c.insuranceEvent?'border-amber-400 bg-amber-50':'bg-white'}`}>
   <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{c.caseNumber}</h3>{c.insuranceEvent?<span className="rounded bg-amber-600 px-2 py-0.5 text-xs font-semibold text-white">Poistná udalosť{c.insuranceLabel?` · ${c.insuranceLabel}`:''}</span>:<span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700">Bez poistnej udalosti</span>}{c.insuranceEvent?<span className={`rounded px-2 py-0.5 text-xs font-semibold ${c.status==='new'?'bg-red-600 text-white':c.status==='taken'?'bg-sky-100 text-sky-900':'bg-emerald-100 text-emerald-900'}`}>{partnerFollowupStatusLabels[c.status]}</span>:null}</div>
   <p className="text-sm">{day(c.createdAt)} · {c.caseType} · {partnerWorkStatusLabels[c.workStatus]}</p><p className="text-sm">{vehicleLabel(c.vehicle)}</p>
   {c.customer?<p className="text-sm">Klient: {c.customer.name||'meno neuvedené'} · {c.customer.phone?<a className="underline" href={`tel:${c.customer.phone}`}>{c.customer.phone}</a>:'telefón neuvedený'}</p>:null}
   {c.takenAt?<p className="text-xs text-zinc-700">Prevzaté {when(c.takenAt)} · účet {c.takenBy}</p>:null}{c.contactedAt?<p className="text-xs text-zinc-700">Klient kontaktovaný {when(c.contactedAt)} · účet {c.contactedBy}</p>:null}
   {c.insuranceEvent?<div className="flex flex-wrap gap-2">{c.status==='new'||pending[`${c.caseId}:take`]?button(c,'take','Prevziať'):null}{c.status==='taken'||pending[`${c.caseId}:contacted`]?button(c,'contacted','Klient kontaktovaný'):null}</div>:null}
   <div className="space-y-2 border-t pt-2"><h4 className="text-sm font-semibold">Moje poznámky</h4>{c.notes.map(n=><p key={n.id} className="whitespace-pre-wrap text-sm"><span className="text-xs text-zinc-600">{when(n.createdAt)} · {n.author}</span><br/>{n.body}</p>)}
    <label className="grid gap-1 text-sm">Nová poznámka<textarea className={control} rows={2} maxLength={2000} value={notes[c.caseId]??''} disabled={Boolean(pending[`${c.caseId}:note`])} onChange={e=>setNotes(n=>({...n,[c.caseId]:e.target.value}))}/></label>{button(c,'note','Pridať poznámku',!(notes[c.caseId]??'').trim())}</div>
  </article>)}</>}
 </section>;
}
