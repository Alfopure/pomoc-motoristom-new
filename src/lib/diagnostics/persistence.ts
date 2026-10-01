import { DIAGNOSTIC_LIMITS, type DiagnosticEvent } from './types';
export type DiagnosticIdentity = {
    profileId: string;
    organizationId: string;
};
export type StoredDiagnostics = {
    actor: DiagnosticIdentity;
    events: DiagnosticEvent[];
};
export interface DiagnosticPersistence {
    read(): Promise<StoredDiagnostics | null>;
    write(value: StoredDiagnostics | null): Promise<void>;
}
/** Per-tab storage preserves reloads without two tabs consuming the same queue. */
export function createDiagnosticPersistence(pageId: string): DiagnosticPersistence {
    async function database(): Promise<IDBDatabase | null> {
        try {
            if (typeof indexedDB === 'undefined')
                return null;
            return await new Promise((resolve) => {
                const request = indexedDB.open('dispatch-diagnostics-v1', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('queues');
                request.onsuccess = () => resolve(request.result);
                request.onerror = request.onblocked = () => resolve(null);
            });
        }
        catch {
            return null;
        }
    }
    return {
        async read() {
            const db = await database();
            if (!db)
                return null;
            return new Promise((resolve) => {
                try {
                    const tx = db.transaction('queues', 'readwrite');
                    const store = tx.objectStore('queues');
                    let value: StoredDiagnostics | null = null;
                    const cursor = store.openCursor();
                    cursor.onsuccess = () => {
                        const row = cursor.result;
                        if (!row)
                            return;
                        const saved = row.value as StoredDiagnostics;
                        // Remove abandoned tab queues after their maximum event TTL.
                        if (!saved || !Array.isArray(saved.events) || !saved.events.some(e => e && Date.parse(e.occurredAt) > Date.now() - DIAGNOSTIC_LIMITS.ttlMs))
                            row.delete();
                        else if (row.key === pageId)
                            value = saved;
                        row.continue();
                    };
                    tx.oncomplete = () => { db.close(); resolve(value); };
                    tx.onerror = tx.onabort = () => { db.close(); resolve(null); };
                }
                catch {
                    db.close();
                    resolve(null);
                }
            });
        },
        async write(value) {
            const db = await database();
            if (!db)
                return;
            await new Promise<void>((resolve) => {
                try {
                    const tx = db.transaction('queues', 'readwrite');
                    if (value?.events.length)
                        tx.objectStore('queues').put(value, pageId);
                    else
                        tx.objectStore('queues').delete(pageId);
                    tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
                }
                catch {
                    db.close();
                    resolve();
                }
            });
        },
    };
}
