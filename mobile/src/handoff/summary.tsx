import type { MobileHandoffSnapshot } from '../../../src/lib/mobile-api';
import { InfoRow } from '../design/detail';
import { Group } from '../design/list';
import { snapshotRows } from './summary-rows';
export { handoffTime } from './summary-rows';
/** Every field the colleague receives, as label/value rows; empty fields say so. */
export function HandoffSummary({ value }: {
  value: MobileHandoffSnapshot;
}) {
  return <Group>{snapshotRows(value).map(([label, text], index) => <InfoRow key={label} first={index === 0} label={label} value={text} />)}</Group>;
}
