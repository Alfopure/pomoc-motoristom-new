import {describe,it,expect} from 'vitest';
import {reserveDiagnosticAttempt} from './traffic';
describe('shared upload budget',()=>{
 it('allows only 12 attempts per sliding minute across transports',()=>{
  for(let i=0;i<12;i++)expect(reserveDiagnosticAttempt(1000)).toBe(true);
  expect(reserveDiagnosticAttempt(1000)).toBe(false);
  expect(reserveDiagnosticAttempt(60999)).toBe(false);
  expect(reserveDiagnosticAttempt(61000)).toBe(true);
 });
});
