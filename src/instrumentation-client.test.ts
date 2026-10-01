import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./lib/diagnostics/errors', () => ({ captureDiagnosticError: vi.fn() }));
vi.mock('./lib/diagnostics/client', () => ({ flushDiagnostics: vi.fn(async () => {}), recordDiagnostic: vi.fn() }));
import { captureDiagnosticError } from './lib/diagnostics/errors';
class ScriptFixture {
  constructor(public src: string) {}
}
class ErrorFixture extends Event {
  constructor(public error: Error) { super('error'); }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });
async function listener() {
  vi.useFakeTimers();
  const addEventListener = vi.fn();
  vi.stubGlobal('window', { addEventListener });
  vi.stubGlobal('location', { origin: 'https://app.test' });
  vi.stubGlobal('HTMLScriptElement', ScriptFixture);
  vi.stubGlobal('ErrorEvent', ErrorFixture);
  await import('./instrumentation-client');
  return addEventListener.mock.calls.find(([name]) => name === 'error')![1] as (event: Event) => void;
}
function resource(target: unknown) {
  const event = new Event('error');
  Object.defineProperty(event, 'target', { value: target });
  return event;
}
describe('early error classification', () => {
  it('ignores image, CSS, external scripts and unrelated same-origin scripts', async () => {
    const capture = await listener();
    for (const target of [
      { src: 'https://app.test/missing-image.png' },
      { href: 'https://app.test/_next/static/styles.css' },
      new ScriptFixture('https://external.test/_next/static/chunks/abc.js'),
      new ScriptFixture('https://app.test/third-party.js'),
    ]) capture(resource(target));
    expect(captureDiagnosticError).not.toHaveBeenCalled();
  });
  it('captures JavaScript errors and same-origin Next script failures', async () => {
    const capture = await listener();
    const error = new TypeError('private message');
    capture(new ErrorFixture(error));
    capture(resource(new ScriptFixture('https://app.test/_next/static/chunks/08dc.-edxpw7t.js')));
    expect(captureDiagnosticError).toHaveBeenNthCalledWith(1, error, 'ui_error');
    expect(captureDiagnosticError).toHaveBeenNthCalledWith(2, undefined, 'chunk_error');
  });
});
