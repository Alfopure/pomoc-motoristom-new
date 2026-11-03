import { describe, expect, it, vi } from 'vitest';
import { diagnosticAuthTags, isExpectedLoginRejection } from './auth-error';
import { sanitizeDiagnosticException, sanitizeOutboundDiagnosticException } from './sentry';

const origin = 'https://app.test';
const auth = (code: string, status: number) => Object.assign(new Error('CANARY_EMAIL password=CANARY_SECRET'), { name: 'AuthApiError', code, status });
describe('safe login diagnosis', () => {
    it('only suppresses explicit invalid credentials, never outages, throttles or unknown errors', () => {
        expect(isExpectedLoginRejection(auth('invalid_credentials', 400))).toBe(true);
        expect(isExpectedLoginRejection(auth('invalid_credentials', 401))).toBe(true);
        for (const error of [auth('invalid_credentials', 500), auth('unexpected_failure', 500), auth('over_request_rate_limit', 429), auth('unknown', 400), new TypeError('network')]) expect(isExpectedLoginRejection(error)).toBe(false);
    });
    it('retains allowlisted provider class/code/status through both privacy boundaries', () => {
        const event = sanitizeDiagnosticException(auth('request_timeout', 504), 'a'.repeat(32), 'release', origin)!;
        expect(event.tags).toMatchObject({ auth_error_class: 'AuthApiError', auth_error_code: 'request_timeout', auth_http_status: '504' });
        expect(sanitizeOutboundDiagnosticException(event, origin)?.tags).toEqual(event.tags);
        expect(JSON.stringify(event)).not.toMatch(/CANARY|password/);
        expect(diagnosticAuthTags(auth('CANARY', 400))).not.toHaveProperty('auth_error_code');
    });
    it('does not invoke arbitrary code/status accessors', () => {
        const getter = vi.fn(() => { throw Error('CANARY'); });
        const error = Object.defineProperties(Object.assign(new Error('CANARY'), { name: 'AuthApiError' }), { code: { get: getter }, status: { get: getter } });
        expect(diagnosticAuthTags(error)).toEqual({ auth_error_class: 'AuthApiError' });
        expect(getter).not.toHaveBeenCalled();
    });
});
