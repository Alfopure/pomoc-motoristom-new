'use client';
import { ErrorFallback } from '@/lib/diagnostics/ErrorFallback';
export default function RouteError({ error, unstable_retry }: {
    error: Error & {
        digest?: string;
    };
    unstable_retry: () => void;
}) {
    return <ErrorFallback error={error} retry={unstable_retry}/>;
}
