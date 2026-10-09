import {describe,it,expect,vi} from 'vitest';
import {runInNewContext} from 'node:vm';
import {diagnosticErrorClass, sanitizeDiagnosticException, sanitizeOutboundDiagnosticException} from './sentry';
describe('Sentry privacy boundary',()=>{
  it('preserves the first Safari frame and React code without retaining message arguments',()=>{
    const error=new Error('Minified React error #185; visit https://react.dev/errors/185?args[]=CANARY_EMAIL@example.com');
    error.stack='CANARY_FUNCTION@https://app.test/_next/static/chunks/abcdef1234567890.js?token=CANARY_SECRET:12:34\nnext@https://app.test/_next/static/chunks/1234567890abcdef.js:56:78';
    const event=sanitizeDiagnosticException(error,'d'.repeat(32),'build','https://app.test');
    expect(event?.exception.values[0].stacktrace?.frames.at(-1)).toEqual({filename:'https://app.test/_next/static/chunks/abcdef1234567890.js',lineno:12,colno:34,in_app:true});
    expect(event?.exception.values[0].value).toBe('React error #185');
    expect(event?.tags.react_error_code).toBe('185');
    expect(JSON.stringify(event)).not.toMatch(/CANARY|example.com|args|token/);
  });
  it('recognizes the development depth error while dropping its entire prose',()=>{
    const event=sanitizeDiagnosticException(new Error('Maximum update depth exceeded. CANARY private arguments'),'e'.repeat(32),'build','https://app.test');
    expect(event?.tags.react_error_code).toBe('185');
    expect(JSON.stringify(event)).not.toContain('CANARY');
  });
  it('revalidates SDK additions and retains only closed technical context',()=>{
    const safe=sanitizeDiagnosticException(new Error('CANARY'),'f'.repeat(32),'build','https://app.test')!;
    const event=sanitizeOutboundDiagnosticException({...safe,environment:'production',user:{email:'CANARY'},request:{url:'CANARY'},extra:{secret:'CANARY'},
      tags:{...safe.tags,diagnostic_page_id:'11111111-1111-4111-8111-111111111111',browser_family:'Safari',browser_version:'27.0.1',private:'CANARY'},
      contexts:{dispatch_ui:{case_id:'22222222-2222-4222-8222-222222222222',dirty:true,save_phase:'saving',draft:'CANARY'},os:{name:'CANARY'}},
      breadcrumbs:[{timestamp:123,category:'diagnostic.operation',data:{module:'cases',operation:'case.save',phase:'finish',outcome:'failed',message:'CANARY'}},{timestamp:123,category:'console',message:'CANARY'}]
    },'https://app.test');
    expect(event?.environment).toBe('production');
    expect(event?.tags).toMatchObject({browser_family:'Safari',browser_version:'27.0.1',diagnostic_page_id:'11111111-1111-4111-8111-111111111111'});
    expect(event?.contexts?.dispatch_ui).toMatchObject({dirty:true,save_phase:'saving'});
    expect(event?.breadcrumbs).toHaveLength(1);
    expect(JSON.stringify(event)).not.toMatch(/CANARY|user|request|extra|draft/);
  });
  it('preserves actual Next 16 Turbopack filenames without query data',()=>{
    for(const filename of ['0rotjcs-dgoli.js','08dc.-edxpw7t.js','turbopack-0qkv5p8l~4f0q.js']){
      const error=new Error('CANARY');error.stack=`Error: CANARY\n at https://app.test/_next/static/chunks/${filename}?token=CANARY:23:45`;
      const event=sanitizeDiagnosticException(error,'c'.repeat(32),'build','https://app.test');
      expect(event?.exception.values[0].stacktrace?.frames[0]).toEqual({filename:`https://app.test/_next/static/chunks/${filename}`,lineno:23,colno:45,in_app:true});
      expect(JSON.stringify(event)).not.toContain('CANARY');
    }
  });

  it('preserves hosted Next 16.3 immutable chunk frames through both privacy boundaries',()=>{
    const filename='https://app.test/_next/static/immutable/chunks/3bwhjg2vhs-n-.js';
    const error=new Error('CANARY private input');
    error.stack=`Error: CANARY\n at onClick (${filename}?dpl=dpl_public&token=CANARY:1:375)`;
    const event=sanitizeDiagnosticException(error,'6'.repeat(32),'build','https://app.test')!;
    const frame={filename,lineno:1,colno:375,in_app:true};
    expect(event.exception.values[0].stacktrace?.frames).toEqual([frame]);
    expect(sanitizeOutboundDiagnosticException(event,'https://app.test')?.exception.values[0].stacktrace?.frames).toEqual([frame]);
    const fallback=sanitizeDiagnosticException(null,'7'.repeat(32),'build','https://app.test',{source:{filename:`${filename}?CANARY`,lineno:1,colno:375}});
    expect(fallback?.exception.values[0].stacktrace?.frames).toEqual([frame]);
    expect(JSON.stringify([event,fallback])).not.toMatch(/CANARY|token|dpl_public|onClick/);
  });

  it('does not broaden immutable chunks to private paths, foreign origins or credentialed URLs',()=>{
    for(const filename of [
      'https://foreign.test/_next/static/immutable/chunks/3bwhjg2vhs-n-.js',
      'https://CANARY@app.test/_next/static/immutable/chunks/3bwhjg2vhs-n-.js',
      'https://app.test/_next/static/immutable/private/3bwhjg2vhs-n-.js',
      'https://app.test/_next/static/private/chunks/3bwhjg2vhs-n-.js',
      'https://app.test/_next/static/immutable/chunks/nested/3bwhjg2vhs-n-.js',
      'https://app.test/_next/static/immutable/chunks/CANARY.tsx',
    ]) {
      const event=sanitizeDiagnosticException(null,'8'.repeat(32),'build','https://app.test',{source:{filename,lineno:1,colno:375}});
      expect(event?.exception.values[0]).not.toHaveProperty('stacktrace');
      expect(JSON.stringify(event)).not.toContain('CANARY');
    }
  });

  it('retains only owned hashed chunk coordinates and opaque correlation',()=>{
    const error=new TypeError('CANARY_EMAIL@example.com +421901123456 token=CANARY_SECRET private note');
    error.stack=`${error.name}: ${error.message}\n at CANARY_FUNCTION (https://app.test/_next/static/chunks/abcdef1234567890.js?token=CANARY_SECRET:12:34)\n at https://foreign.test/CANARY_SECRET.js:2:3\n at https://app.test/private/CANARY_SECRET:2:3`;
    const event=sanitizeDiagnosticException(error,'a'.repeat(32),'build_abc','https://app.test');
    const json=JSON.stringify(event);
    expect(json).not.toMatch(/CANARY|421901|example.com|foreign|private|token/);
    expect(event?.exception.values[0].stacktrace?.frames).toEqual([{filename:'https://app.test/_next/static/chunks/abcdef1234567890.js',lineno:12,colno:34,in_app:true}]);
    expect(event?.exception.values[0].value).toBe('TypeError');
  });
  it('does not retain arbitrary exception class or non-error rejection data',()=>{
    const error=new Error('private');error.name='CANARY_SECRET';
    expect(sanitizeDiagnosticException(error,'b'.repeat(32),'build','https://app.test')?.exception.values[0].type).toBe('UnknownError');
    expect(JSON.stringify(sanitizeDiagnosticException({email:'CANARY_EMAIL'},'b'.repeat(32),'build','https://app.test'))).not.toContain('CANARY');
  });
  it('keeps a real cross-realm error class, React code and owned frame',()=>{
    const error=runInNewContext('new TypeError("Minified React error #185; CANARY private arguments")');
    error.stack='CANARY_FN@https://app.test/_next/static/chunks/abcdef1234567890.js:12:34';
    expect(error instanceof Error).toBe(false);
    const event=sanitizeDiagnosticException(error,'1'.repeat(32),'build','https://app.test');
    expect(event?.exception.values[0]).toMatchObject({type:'TypeError',value:'React error #185',stacktrace:{frames:[{lineno:12,colno:34}]}});
    expect(JSON.stringify(event)).not.toContain('CANARY');
  });
  it('uses available ErrorEvent coordinates when the browser supplies no stack',()=>{
    const event=sanitizeDiagnosticException(null,'2'.repeat(32),'build','https://app.test',{source:{filename:'https://app.test/_next/static/chunks/abcdef1234567890.js?CANARY_SECRET',lineno:12,colno:34}});
    expect(event?.exception.values[0]).toMatchObject({type:'UnknownError',stacktrace:{frames:[{filename:'https://app.test/_next/static/chunks/abcdef1234567890.js',lineno:12,colno:34}]}});
    expect(JSON.stringify(event)).not.toContain('CANARY');
  });
  it('rejects foreign, private, credentialed and invalid fallback coordinates without inventing a stack',()=>{
    for(const source of [
      {filename:'https://foreign.test/_next/static/chunks/abcdef1234567890.js',lineno:12,colno:34},
      {filename:'https://app.test/private/CANARY.js',lineno:12,colno:34},
      {filename:'https://CANARY@app.test/_next/static/chunks/abcdef1234567890.js',lineno:12,colno:34},
      {filename:'https://app.test/_next/static/chunks/abcdef1234567890.js',lineno:0,colno:34},
      {filename:'https://app.test/_next/static/chunks/abcdef1234567890.js',lineno:12,colno:Infinity},
    ]) expect(sanitizeDiagnosticException(null,'3'.repeat(32),'build','https://app.test',{source})?.exception.values[0]).not.toHaveProperty('stacktrace');
  });
  it('does not invoke untrusted Error field or forged brand getters',()=>{
    const getter=vi.fn(()=>{throw Error('CANARY');});
    const forged=Object.defineProperty({name:'TypeError',stack:'CANARY'},Symbol.toStringTag,{get:getter});
    expect(diagnosticErrorClass(forged)).toBe('UnknownError');
    const error=Object.defineProperty(new Error(), 'name', {get:getter});
    expect(diagnosticErrorClass(error)).toBe('UnknownError');
    expect(sanitizeDiagnosticException(error,'4'.repeat(32),'build','https://app.test')).not.toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
  it('retains standard DOMException classes without reading overridden accessors',()=>{
    const getter=vi.fn(()=>{throw Error('CANARY');});
    const error=Object.defineProperty(new DOMException('CANARY private data','AbortError'),'name',{get:getter});
    expect(diagnosticErrorClass(error)).toBe('AbortError');
    const event=sanitizeDiagnosticException(error,'5'.repeat(32),'build','https://app.test');
    expect(event?.exception.values[0].type).toBe('AbortError'); expect(JSON.stringify(event)).not.toContain('CANARY'); expect(getter).not.toHaveBeenCalled();
  });
});
