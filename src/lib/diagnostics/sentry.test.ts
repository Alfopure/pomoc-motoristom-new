import {describe,it,expect} from 'vitest';
import {sanitizeDiagnosticException, sanitizeOutboundDiagnosticException} from './sentry';
describe('Sentry privacy boundary',()=>{
  it('preserves the first Safari frame and React code without retaining message arguments',()=>{
    const error=new Error('Minified React error #185; visit https://react.dev/errors/185?args[]=CANARY_EMAIL@example.com');
    error.stack='CANARY_FUNCTION@https://app.test/_next/static/chunks/abcdef1234567890.js?token=CANARY_SECRET:12:34\nnext@https://app.test/_next/static/chunks/1234567890abcdef.js:56:78';
    const event=sanitizeDiagnosticException(error,'d'.repeat(32),'build','https://app.test');
    expect(event?.exception.values[0].stacktrace.frames.at(-1)).toEqual({filename:'https://app.test/_next/static/chunks/abcdef1234567890.js',lineno:12,colno:34,in_app:true});
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
      expect(event?.exception.values[0].stacktrace.frames[0]).toEqual({filename:`https://app.test/_next/static/chunks/${filename}`,lineno:23,colno:45,in_app:true});
      expect(JSON.stringify(event)).not.toContain('CANARY');
    }
  });

  it('retains only owned hashed chunk coordinates and opaque correlation',()=>{
    const error=new TypeError('CANARY_EMAIL@example.com +421901123456 token=CANARY_SECRET private note');
    error.stack=`${error.name}: ${error.message}\n at CANARY_FUNCTION (https://app.test/_next/static/chunks/abcdef1234567890.js?token=CANARY_SECRET:12:34)\n at https://foreign.test/CANARY_SECRET.js:2:3\n at https://app.test/private/CANARY_SECRET:2:3`;
    const event=sanitizeDiagnosticException(error,'a'.repeat(32),'build_abc','https://app.test');
    const json=JSON.stringify(event);
    expect(json).not.toMatch(/CANARY|421901|example.com|foreign|private|token/);
    expect(event?.exception.values[0].stacktrace.frames).toEqual([{filename:'https://app.test/_next/static/chunks/abcdef1234567890.js',lineno:12,colno:34,in_app:true}]);
    expect(event?.exception.values[0].value).toBe('TypeError');
  });
  it('does not retain arbitrary exception class or non-error rejection data',()=>{
    const error=new Error('private');error.name='CANARY_SECRET';
    expect(sanitizeDiagnosticException(error,'b'.repeat(32),'build','https://app.test')?.exception.values[0].type).toBe('UnknownError');
    expect(JSON.stringify(sanitizeDiagnosticException({email:'CANARY_EMAIL'},'b'.repeat(32),'build','https://app.test'))).not.toContain('CANARY');
  });
});
