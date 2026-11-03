import type { Metadata } from 'next';
import { OperationGrantRecipient } from '@/components/operations/OperationGrantRecipient';
export const metadata: Metadata = { title: 'Pridelená jazda', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default function Page() { return <OperationGrantRecipient />; }
