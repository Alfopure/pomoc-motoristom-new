import {describe,it,expect} from 'vitest';
import {sanitizeDiagnosticException} from './sentry';
describe('Sentry privacy boundary',()=>{
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
