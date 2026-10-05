type ErrorField = 'name' | 'message' | 'stack';
const stackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get ?? Object.getOwnPropertyDescriptor(Error.prototype, 'stack')?.get;
const domNameGetter = typeof DOMException === 'undefined' ? undefined : Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get;
const domMessageGetter = typeof DOMException === 'undefined' ? undefined : Object.getOwnPropertyDescriptor(DOMException.prototype, 'message')?.get;

/** Read real errors across browser realms without calling arbitrary field getters. */
export function diagnosticErrorText(error: unknown, field: ErrorField): string {
    try {
        if (!error || typeof error !== 'object') return '';
        let domException = false;
        try {
            // Native DOM accessors perform a brand check, including across realms.
            // They never invoke a supplied object's name/message getters.
            const name: unknown = domNameGetter?.call(error);
            domException = typeof name === 'string';
            if (domException && field === 'name') return (name as string).slice(0, 1024);
            if (domException && field === 'message') return String(domMessageGetter?.call(error) ?? '').slice(0, 1024);
        } catch { /* Ordinary Errors do not have DOMException's native slots. */ }
        let prototype: object | null = error;
        // A forged toStringTag must not turn an arbitrary rejection into an Error.
        if (!domException) {
            for (let depth = 0; prototype && depth < 8; depth++, prototype = Object.getPrototypeOf(prototype)) {
                if (Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)) return '';
            }
            if (prototype || Object.prototype.toString.call(error) !== '[object Error]') return '';
        }
        if (field === 'stack') {
            // Lazy native stack formatting can itself read name/message. Check
            // these descriptors before requesting even the stack descriptor.
            for (const key of ['name', 'message']) {
                let owner: object | null = error;
                for (let count = 0; owner && count < 8; count++, owner = Object.getPrototypeOf(owner)) {
                    const property = Object.getOwnPropertyDescriptor(owner, key);
                    if (!property) continue;
                    const nativeDomGetter = key === 'name' ? domNameGetter : domMessageGetter;
                    if (property.set || (property.get && (!domException || property.get !== nativeDomGetter))) return '';
                    break;
                }
            }
        }
        prototype = error;
        for (let depth = 0; prototype && depth < 8; depth++, prototype = Object.getPrototypeOf(prototype)) {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, field);
            if (!descriptor) continue;
            if (typeof descriptor.value === 'string') return descriptor.value.slice(0, field === 'stack' ? 16384 : 1024);
            // Recent V8 exposes its lazily formatted stack as an accessor. Invoke
            // our captured native getter, never the accessor on the supplied object.
            if (field === 'stack' && stackGetter) {
                const stack: unknown = stackGetter.call(error);
                return typeof stack === 'string' ? stack.slice(0, 16384) : '';
            }
            return '';
        }
    } catch { /* Nonstandard objects and revoked proxies fail closed. */ }
    return '';
}
