import { isDiagnosticUuid } from './types';
export type DiagnosticCallContext = {
    callSessionId?: string;
    deviceSessionId?: string;
};
let active: DiagnosticCallContext = {};
let recent: {
    context: DiagnosticCallContext;
    expiresAt: number;
} | null = null;
/** Only UUID evidence is retained; the server still verifies ownership at ingestion. */
export function setDiagnosticCallContext(value: DiagnosticCallContext | null): void {
    try {
        recent = null;
        active = value ? {
            ...(isDiagnosticUuid(value.callSessionId) ? { callSessionId: value.callSessionId } : {}),
            ...(isDiagnosticUuid(value.deviceSessionId) ? { deviceSessionId: value.deviceSessionId } : {}),
        } : {};
    }
    catch {
        active = {};
        recent = null;
    }
}
/** A boundary runs after React cleanup. Retain only this explicit unmount observation for 5s. */
export function retainDiagnosticCallContext(reason: string): void {
    try {
        recent = reason === 'component_unmount' && Object.keys(active).length ? { context: { ...active }, expiresAt: performance.now() + 5000 } : null;
        active = {};
    }
    catch {
        active = {};
        recent = null;
    }
}
export function getDiagnosticCallContext(): DiagnosticCallContext {
    try {
        if (Object.keys(active).length)
            return { ...active };
        if (recent && performance.now() < recent.expiresAt)
            return { ...recent.context };
        recent = null;
    }
    catch { /* no-throw */ }
    return {};
}
