'use client';
import { ErrorFallback } from '@/lib/diagnostics/ErrorFallback';
export default function GlobalError({ error, unstable_retry }: {
    error: Error & {
        digest?: string;
    };
    unstable_retry: () => void;
}) {
    return <html lang="sk"><body><ErrorFallback error={error} retry={unstable_retry}/></body></html>;
}
