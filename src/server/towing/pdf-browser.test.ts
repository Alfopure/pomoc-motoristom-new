import { expect, it } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { generateTowingPdf } from './documents';
/** Explicit local acceptance check; deployment gate uses deterministic renderer/HTTP tests. */
it.runIf(process.env.TOWING_TEST_PDF_BROWSER === 'true')('keeps the synthetic live acceptance baseline on one page after Slovak label rendering',async()=>{
  const pdf=await generateTowingPdf({number:'Z-TEST-ACCEPTANCE',version:1,kind:'work',fields:{serviceType:'tow',subjectType:'vehicle',subjectDescription:'TEST AKCEPTÁCIA 2026-10-13 – BEZ REÁLNEHO ZÁKAZNÍKA',pickup:'TEST miesto A – syntetická nakládka',destination:'TEST miesto B – syntetické odovzdanie',noContactReason:'Syntetická akceptačná skúška, bez reálneho zákazníka.'}},'synthetic-snapshot-hash');
  expect(pdf.subarray(0,5).toString()).toBe('%PDF-');
  expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)).toHaveLength(1);
  await mkdir('.context/towing-evidence',{recursive:true});await writeFile('.context/towing-evidence/slovak-labels-synthetic-baseline.pdf',pdf);
},45000);
it.runIf(process.env.TOWING_TEST_PDF_BROWSER === 'true')('renders a complete multipage Slovak work order using Chromium',async()=>{
  const lines=Array.from({length:50},(_,i)=>({id:String(i),description:`Výkon ${i+1} — ${'Dlhý slovenský popis odťahu a prepravy stroja. '.repeat(12)}`,quantity:'1.000',unit:'ks',unitPrice:'10.0000',taxRate:'0',totalCents:1000}));
  const pdf=await generateTowingPdf({number:'Z-SYNTHETIC-50',version:1,kind:'priced',fields:{serviceType:'transport',subjectType:'machine',subjectDescription:'Syntetický stroj — žľťšť',pickup:'Syntetická nakládka',destination:'Syntetická vykládka'},lines,totalCents:50000,taxDate:'2026-10-13'},'synthetic-snapshot-hash');
  expect(pdf.subarray(0,5).toString()).toBe('%PDF-');
  const pages=pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  expect(pages).toBeGreaterThan(1);
  await mkdir('.context/towing-evidence',{recursive:true});await writeFile('.context/towing-evidence/multipage-synthetic-work-order.pdf',pdf);
  console.info('towing_pdf_acceptance',{pages,bytes:pdf.length});
},45000);
