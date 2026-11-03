import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import chromium from '@sparticuz/chromium';
import { chromium as playwright, type Browser } from 'playwright-core';
import type { TowingCommandResult, TowingDocument, TowingMember } from '@/domain/towing/types';
import { sendEmailWithOutcome } from '@/server/email-delivery';
import { executeTowingCommand } from './service';
import { followupCommandId, loadTowingFile, readTowingFile, sha256, storeImmutableFile, TOWING_BUCKET, verifyTowingFile } from './files';
import { towingAdmin } from './client';
import { revision, TowingError, uuid } from './http';
import { renderTowingPdf, type TowingPdfSnapshot } from './pdf-template';

export async function generateTowingPdf(snapshot: TowingPdfSnapshot, hash: string): Promise<Buffer> {
  let browser: Browser | undefined; let expired = false; let closing: Promise<void> | undefined;
  const close = () => closing ??= browser?.close().catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_,reject) => { timer = setTimeout(() => { expired = true; void close(); reject(new TowingError('render_timeout',503,'Vytvorenie PDF sa nepodarilo potvrdiť.')); },40_000); });
  const render = async () => {
    const [regular,bold,executablePath] = await Promise.all([
      readFile(path.join(process.cwd(),'src/assets/pdf-fonts/LiberationSans-Regular.ttf')),
      readFile(path.join(process.cwd(),'src/assets/pdf-fonts/LiberationSans-Bold.ttf')),
      process.env.CASE_PDF_CHROME_PATH || chromium.executablePath(),
    ]);
    if (expired) throw new Error('PDF deadline');
    browser = await playwright.launch({executablePath,args:process.env.CASE_PDF_CHROME_PATH ? ['--no-sandbox'] : chromium.args,headless:true,timeout:10000});
    if (expired) { await close(); throw new Error('PDF deadline'); }
    const page = await browser.newPage({locale:'sk-SK',javaScriptEnabled:false});
    await page.route('**/*',route => route.abort());
    await page.setContent(renderTowingPdf(snapshot,hash,regular.toString('base64'),bold.toString('base64')),{waitUntil:'load',timeout:15000});
    await page.evaluate(() => document.fonts.ready);
    const bytes = await page.pdf({format:'A4',printBackground:true,displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:'<div style="font-size:8px;color:#71717a;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'});
    if (expired) throw new Error('PDF deadline');
    return bytes;
  };
  try { return await Promise.race([render(),timeout]); } finally { clearTimeout(timer!); await close(); }
}
export async function issueTowingDocument(actor: TowingMember, orderId: string, input: Record<string,unknown>) {
  const commandId = uuid(input.commandId); const id = uuid(input.documentId); const expectedRevision = revision(input.expectedRevision);
  if (input.kind !== 'work' && input.kind !== 'priced') throw new TowingError('invalid_input',400,'Vyberte typ zákazkového listu.');
  let issued: TowingCommandResult;
  if (input.retry === true) {
    const existing = await loadTowingFile(actor, id, 'document');
    if (existing.orderId !== orderId || existing.kind !== input.kind || !existing.snapshot || !existing.snapshotHash || !existing.version)
      throw new TowingError('not_found',404,'Táto verzia dokumentu nie je dostupná.');
    // Re-render only the already reserved snapshot, never the order's current contents.
    issued = { commandId, targetId: orderId, revision: expectedRevision, result: { document: {
      id, kind: existing.kind, snapshot: existing.snapshot, snapshotHash: existing.snapshotHash,
      version: existing.version, status: existing.status, createdAt: existing.createdAt,
    } } };
  } else {
    issued = await executeTowingCommand(actor,{commandId,type:'issue_document',targetId:orderId,expectedRevision,payload:{id,kind:input.kind}});
  }
  const document = issued.result?.document as TowingDocument | undefined;
  if (!document?.snapshot || !document.snapshotHash || document.id !== id) throw new TowingError('unavailable',503,'Snapshot dokumentu nie je dostupný.');
  if (document.status === 'ready') return issued;
  const snapshot = document.snapshot as unknown as TowingPdfSnapshot;
  if (!snapshot.fields || !snapshot.number || JSON.stringify(snapshot).length > 4_000_000) throw new TowingError('invalid_snapshot',503,'Údaje dokumentu nie sú úplné.');
  try {
    // The initial command result is immutable and can still say generating after a lost response.
    const current = await loadTowingFile(actor,id,'document');
    if (current.status === 'ready') return {...issued,result:{...issued.result,document:{...document,status:'ready'}}};
    const stored = await towingAdmin().storage.from(TOWING_BUCKET).download(`${actor.organizationId}/${orderId}/${id}.pdf`);
    let bytes: Buffer;
    if (stored.data) { bytes = Buffer.from(await stored.data.arrayBuffer()); verifyTowingFile(bytes,'application/pdf'); }
    else {
      if (stored.error && !['404','400'].includes(String(stored.error.statusCode)) && !/not found|does not exist/i.test(stored.error.message)) throw new TowingError('unavailable',503,'Úložisko dokumentov nie je dostupné.');
      bytes = await generateTowingPdf({...snapshot,version:document.version,kind:document.kind},document.snapshotHash);
    }
    await storeImmutableFile(`${actor.organizationId}/${orderId}/${id}.pdf`,bytes,'application/pdf');
    const finalized = await executeTowingCommand(actor,{commandId:followupCommandId(commandId,'ready'),type:'document_result',targetId:orderId,payload:{id,status:'ready',sha256:sha256(bytes),size:bytes.length}});
    return {...finalized,commandId};
  } catch (error) {
    try { await executeTowingCommand(actor,{commandId:followupCommandId(commandId,'failed'),type:'document_result',targetId:orderId,payload:{id,status:'failed',error:'render_failed'}}); } catch { /* The reserved immutable document remains visible as generating if status persistence failed. */ }
    throw error;
  }
}
export async function emailTowingDocument(actor: TowingMember, orderId: string, input: Record<string,unknown>) {
  const commandId = uuid(input.commandId); const documentId = uuid(input.documentId);
  if (input.confirmed !== true || typeof input.recipient !== 'string' || input.recipient.length > 254 || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(input.recipient))
    throw new TowingError('invalid_input',400,'Potvrďte jednu emailovú adresu príjemcu.');
  const recipient = input.recipient.toLowerCase().trim();
  const {file,bytes} = await readTowingFile(actor,documentId,'document',orderId);
  const intent = await executeTowingCommand(actor,{commandId,type:'email_intent',targetId:orderId,payload:{id:commandId,documentId,recipient,confirmed:true}});
  if (intent.result?.shouldSend !== true) return intent;
  const outcome = await sendEmailWithOutcome({to:recipient,subject:'Kópia zákazkového listu',html:'<p>V prílohe je potvrdená verzia zákazkového listu.</p>',text:'V prílohe je potvrdená verzia zákazkového listu.',
    attachments:[{filename:file.name,content:bytes.toString('base64'),contentType:'application/pdf'}],idempotencyKey:`towing-${commandId}`});
  const status = outcome.status === 'sent' ? 'accepted' : outcome.status === 'unknown' ? 'unknown' : 'failed';
  return executeTowingCommand(actor,{commandId:followupCommandId(commandId,'email_result'),type:'email_result',targetId:orderId,
    payload:{id:commandId,status,providerMessageId:outcome.status === 'sent' ? outcome.messageId : null,error:outcome.status === 'disabled' ? 'email_disabled' : outcome.status === 'failed' ? 'provider_rejected' : outcome.status === 'unknown' ? 'provider_outcome_unknown' : null}});
}
