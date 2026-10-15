import { diagnosticErrorText } from './error-value';

const classes = ['AuthError', 'AuthApiError', 'AuthUnknownError', 'AuthRetryableFetchError', 'AuthInvalidCredentialsError'] as const;
const codes = ['invalid_credentials', 'email_not_confirmed', 'user_banned', 'validation_failed', 'unexpected_failure', 'request_timeout', 'over_request_rate_limit', 'provider_disabled', 'email_provider_disabled', 'hook_timeout', 'hook_timeout_after_retry'] as const;
export type DiagnosticAuthTags = { auth_error_class?: typeof classes[number]; auth_error_code?: typeof codes[number]; auth_http_status?: string };

/** No messages, credentials, response bodies or arbitrary getters leave this boundary. */
export function diagnosticAuthTags(error: unknown): DiagnosticAuthTags {
    try {
        const name = diagnosticErrorText(error, 'name');
        if (!classes.includes(name as typeof classes[number])) return {};
        const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
        const status = Object.getOwnPropertyDescriptor(error, 'status')?.value;
        return sanitizeAuthTags({ auth_error_class: name, auth_error_code: code, auth_http_status: Number.isInteger(status) ? String(status) : undefined });
    } catch { return {}; }
}
export function sanitizeAuthTags(value: unknown): DiagnosticAuthTags {
    try {
        const input = value as DiagnosticAuthTags;
        if (!input || !classes.includes(input.auth_error_class!)) return {};
        return { auth_error_class: input.auth_error_class,
            ...(codes.includes(input.auth_error_code!) ? { auth_error_code: input.auth_error_code } : {}),
            ...(/^[45][0-9]{2}$/.test(input.auth_http_status ?? '') ? { auth_http_status: input.auth_http_status } : {}) };
    } catch { return {}; }
}
/** Only an explicit credential rejection is expected; unknown 4xx still remains observable. */
export function isExpectedLoginRejection(error: unknown): boolean {
    const tags = diagnosticAuthTags(error);
    return tags.auth_error_code === 'invalid_credentials' && (tags.auth_http_status === '400' || tags.auth_http_status === '401');
}
