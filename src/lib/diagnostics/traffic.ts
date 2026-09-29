import { DIAGNOSTIC_LIMITS } from './types';
// Shared by the internal collector and Sentry; no beacon bypass or SDK retry loop.
let attempts: number[] = [];
export function reserveDiagnosticAttempt(now = Date.now()): boolean {
    attempts = attempts.filter(time => time > now - 60000);
    if (attempts.length >= DIAGNOSTIC_LIMITS.attemptsPerMinute)
        return false;
    attempts.push(now);
    return true;
}
