import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { TowingMember } from '@/domain/towing/types';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),upload:vi.fn(),download:vi.fn(),send:vi.fn()}));
vi.mock('./client',()=>({towingAdmin:()=>({rpc:mocks.rpc,storage:{from:()=>({upload:mocks.upload,download:mocks.download})}})}));
vi.mock('@/server/email-delivery',()=>({sendEmailWithOutcome:mocks.send}));
import { readTowingFile, sha256, uploadTowingAttachment } from './files';
import { emailTowingDocument, issueTowingDocument } from './documents';
const actor:TowingMember={id:'10000000-0000-4000-8000-000000000001',userId:'20000000-0000-4000-8000-000000000001',organizationId:'30000000-0000-4000-8000-000000000001',displayName:'Driver',roles:['driver'],capabilities:['drive'],active:true,version:1};
const orderId='40000000-0000-4000-8000-000000000001',attachmentId='50000000-0000-4000-8000-000000000001',commandId='60000000-0000-4000-8000-000000000001';
const bytes=Buffer.from('%PDF-1.7\nsynthetic file\n%%EOF');
function uploadRequest(){const form=new FormData();form.set('file',new File([bytes],'scan.pdf',{type:'application/pdf'}));form.set('attachmentId',attachmentId);form.set('commandId',commandId);form.set('kind','scan');form.set('expectedRevision','1');return new Request('https://test.example/upload',{method:'POST',body:form});}
beforeEach(()=>{mocks.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>name==='motorist_towing_file'?{data:{id:attachmentId,orderId,path:`${actor.organizationId}/${orderId}/${attachmentId}`,mimeType:'application/pdf',name:'scan.pdf',status:'ready',sha256:sha256(bytes)},error:null}:{data:{commandId:(args.p_command as {commandId:string}).commandId,targetId:orderId,revision:2,result:{shouldSend:true}},error:null});mocks.upload.mockResolvedValue({error:null});mocks.download.mockResolvedValue({data:new Blob([bytes]),error:null});mocks.send.mockResolvedValue({status:'sent',messageId:'provider-1',provider:'resend',error:null});});
afterEach(()=>vi.resetAllMocks());
describe('towing upload transaction boundary',()=>{
 it('returns logical command ID, stores own opaque path and finalizes hash after storage success',async()=>{const result=await uploadTowingAttachment(actor,orderId,uploadRequest());expect(result.commandId).toBe(commandId);expect(mocks.upload.mock.calls[0][0]).toBe(`${actor.organizationId}/${orderId}/${attachmentId}`);expect(mocks.upload.mock.calls[0][2]).toMatchObject({upsert:false});const commands=mocks.rpc.mock.calls.map(([,args])=>args.p_command);expect(commands[0]).toMatchObject({type:'attachment_intent',payload:{id:attachmentId,mimeType:'application/pdf'}});expect(commands[1]).toMatchObject({type:'attachment_finalize',payload:{id:attachmentId,sha256:sha256(bytes)}});expect(commands[1].commandId).not.toBe(commandId);});
 it('never finalizes on failed storage, safely reuses matching object on retry',async()=>{mocks.upload.mockResolvedValueOnce({error:{statusCode:'503',message:'temporarily unavailable'}});await expect(uploadTowingAttachment(actor,orderId,uploadRequest())).rejects.toMatchObject({code:'upload_failed'});expect(mocks.rpc).toHaveBeenCalledTimes(1);mocks.upload.mockResolvedValue({error:{statusCode:'409',message:'already exists'}});const result=await uploadTowingAttachment(actor,orderId,uploadRequest());expect(result.commandId).toBe(commandId);});
 it('rejects changed bytes under the same immutable file ID',async()=>{mocks.upload.mockResolvedValue({error:{statusCode:'409',message:'already exists'}});mocks.download.mockResolvedValue({data:new Blob(['different']),error:null});await expect(uploadTowingAttachment(actor,orderId,uploadRequest())).rejects.toMatchObject({code:'file_conflict',status:409});expect(mocks.rpc).toHaveBeenCalledTimes(1);});
 it('reauthorizes after fetching bytes so a reassignment blocks the response',async()=>{mocks.rpc.mockResolvedValueOnce({data:{id:attachmentId,orderId,path:`${actor.organizationId}/${orderId}/${attachmentId}`,mimeType:'application/pdf',name:'scan.pdf',status:'ready',sha256:sha256(bytes)},error:null}).mockResolvedValueOnce({data:null,error:{code:'P0002'}});await expect(readTowingFile(actor,attachmentId,'attachment',orderId)).rejects.toMatchObject({status:404});expect(mocks.download).toHaveBeenCalledTimes(1);expect(mocks.rpc).toHaveBeenCalledTimes(2);});
 it('denies swapped order and foreign organization paths before storage',async()=>{await expect(readTowingFile(actor,attachmentId,'attachment','another-order')).rejects.toMatchObject({status:404});mocks.rpc.mockResolvedValue({data:{orderId,path:`foreign-org/${orderId}/${attachmentId}`,status:'ready'},error:null});await expect(readTowingFile(actor,attachmentId,'attachment',orderId)).rejects.toMatchObject({status:404});expect(mocks.download).not.toHaveBeenCalled();});
});
describe('explicit document email',()=>{
 it('sends exact immutable version with original idempotency and records accepted',async()=>{await emailTowingDocument({...actor,capabilities:['documents']},orderId,{commandId,documentId:attachmentId,recipient:'tester@example.com',confirmed:true});expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({to:'tester@example.com',idempotencyKey:`towing-${commandId}`,attachments:[{filename:'scan.pdf',content:bytes.toString('base64'),contentType:'application/pdf'}]}));const last=mocks.rpc.mock.calls.at(-1)?.[1].p_command;expect(last).toMatchObject({type:'email_result',payload:{status:'accepted',providerMessageId:'provider-1'}});});
 it('records network timeout as unknown and never resends an existing claim',async()=>{mocks.send.mockResolvedValue({status:'unknown',provider:'resend',error:'uncertain'});await emailTowingDocument(actor,orderId,{commandId,documentId:attachmentId,recipient:'tester@example.com',confirmed:true});expect(mocks.rpc.mock.calls.at(-1)?.[1].p_command).toMatchObject({payload:{status:'unknown'}});mocks.rpc.mockImplementation(async(name:string)=>name==='motorist_towing_file'?{data:{id:attachmentId,orderId,path:`${actor.organizationId}/${orderId}/${attachmentId}`,mimeType:'application/pdf',name:'scan.pdf',status:'ready',sha256:sha256(bytes)},error:null}:{data:{commandId,targetId:orderId,revision:1,result:{shouldSend:false}},error:null});await emailTowingDocument(actor,orderId,{commandId,documentId:attachmentId,recipient:'tester@example.com',confirmed:true});expect(mocks.send).toHaveBeenCalledTimes(1);});
});
describe('retrying a reserved PDF version', () => {
 it('uses the original stored snapshot/bytes and never issues a second version', async () => {
  const snapshot = { number: 'Z-historical', kind: 'work', fields: { serviceType: 'tow', subjectType: 'vehicle', subjectDescription: 'Historical', pickup: 'Original location' } };
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'motorist_towing_file'
    ? { data: { id: attachmentId, orderId, path: `${actor.organizationId}/${orderId}/${attachmentId}.pdf`, status: 'failed', kind: 'work', version: 2, snapshot, snapshotHash: 'original-hash' }, error: null }
    : { data: { commandId: (args.p_command as { commandId: string }).commandId, targetId: orderId, revision: 9 }, error: null });
  const result = await issueTowingDocument({ ...actor, capabilities: ['documents'] }, orderId, { commandId, documentId: attachmentId, expectedRevision: 9, kind: 'work', retry: true });
  const commands = mocks.rpc.mock.calls.filter(([name]) => name === 'motorist_towing_command').map(([,args]) => args.p_command);
  expect(commands).toHaveLength(1); expect(commands[0]).toMatchObject({ type: 'document_result', payload: { id: attachmentId, status: 'ready', sha256: sha256(bytes) } });
  expect(result.commandId).toBe(commandId);
  expect(mocks.upload.mock.calls[0][1]).toEqual(bytes);
 });
 it('refuses a retry of a version belonging to another order before touching storage', async () => {
  mocks.rpc.mockResolvedValue({ data: { id: attachmentId, orderId: 'other-order', path: `${actor.organizationId}/other-order/${attachmentId}.pdf`, status: 'failed', kind: 'work', version: 2, snapshot: {}, snapshotHash: 'hash' }, error: null });
  await expect(issueTowingDocument(actor, orderId, { commandId, documentId: attachmentId, expectedRevision: 9, kind: 'work', retry: true })).rejects.toMatchObject({ status: 404 });
  expect(mocks.download).not.toHaveBeenCalled();
 });
});
