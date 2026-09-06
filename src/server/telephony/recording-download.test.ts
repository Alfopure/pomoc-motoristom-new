import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked=vi.hoisted(()=>({lookup:vi.fn(),request:vi.fn()}));
vi.mock('node:dns/promises',()=>({lookup:mocked.lookup}));
vi.mock('node:https',()=>({request:mocked.request}));
import { downloadRecordingChunk } from './recording-storage';
beforeEach(()=>{mocked.lookup.mockReset();mocked.request.mockReset();});
function response(statusCode:number,headers:Record<string,string>,bytes=Buffer.alloc(16)){
 mocked.request.mockImplementation((_url,opts,ready)=>{
  const request=new EventEmitter() as EventEmitter&{end:()=>void};
  request.end=()=>{const res=Object.assign(Readable.from([bytes]),{statusCode,headers});ready(res);};
  return request;
 });
}
describe('pinned recording download',()=>{
 it('pins a validated public address with explicit family, preserving TLS host and Range',async()=>{
  mocked.lookup.mockResolvedValue([{address:'8.8.8.8',family:4}]);response(206,{'content-range':'bytes 0-15/16',etag:'"v1"','content-type':'audio/wav'});
  const result=await downloadRecordingChunk('https://recordings.telnyx.com/audio',0,AbortSignal.timeout(1000),['recordings.telnyx.com']);expect(result.bytes.length).toBe(16);
  const [url,options]=mocked.request.mock.calls[0];expect(url.hostname).toBe('recordings.telnyx.com');expect(options.family).toBe(4);expect(options.headers.Range).toBe('bytes=0-6291455');
  const callback=vi.fn();options.lookup('recordings.telnyx.com',{},callback);expect(callback).toHaveBeenCalledWith(null,'8.8.8.8',4);expect(mocked.lookup).toHaveBeenCalledTimes(1);
 });
 it('refuses mixed DNS answers containing private addresses before making a request',async()=>{
  mocked.lookup.mockResolvedValue([{address:'8.8.8.8',family:4},{address:'169.254.169.254',family:4}]);
  await expect(downloadRecordingChunk('https://recordings.telnyx.com/audio',0,AbortSignal.timeout(1000),['recordings.telnyx.com'])).rejects.toMatchObject({code:'source_private_address'});expect(mocked.request).not.toHaveBeenCalled();
 });
 it('does not follow redirects or accept compressed/mismatching range responses',async()=>{
  mocked.lookup.mockResolvedValue([{address:'8.8.8.8',family:4}]);response(302,{location:'https://internal.test'});
  await expect(downloadRecordingChunk('https://recordings.telnyx.com/audio',0,AbortSignal.timeout(1000),['recordings.telnyx.com'])).rejects.toMatchObject({code:'source_unavailable'});
  response(206,{'content-range':'bytes 0-14/16'});await expect(downloadRecordingChunk('https://recordings.telnyx.com/audio',0,AbortSignal.timeout(1000),['recordings.telnyx.com'])).rejects.toMatchObject({code:'source_range_unsupported'});
  response(206,{'content-range':'bytes 0-15/16','content-encoding':'gzip'});await expect(downloadRecordingChunk('https://recordings.telnyx.com/audio',0,AbortSignal.timeout(1000),['recordings.telnyx.com'])).rejects.toMatchObject({code:'source_encoding_invalid'});
 });
 it('aborts a stalled DNS resolver within the shared deadline',async()=>{
  mocked.lookup.mockReturnValue(new Promise(()=>{}));const controller=new AbortController();const pending=downloadRecordingChunk('https://recordings.telnyx.com/audio',0,controller.signal,['recordings.telnyx.com']);controller.abort();
  await expect(pending).rejects.toMatchObject({code:'source_deadline'});expect(mocked.request).not.toHaveBeenCalled();
 });
});
