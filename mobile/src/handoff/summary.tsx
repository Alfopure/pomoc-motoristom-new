import type { MobileHandoffSnapshot } from '../../../src/lib/mobile-api';
import { Text, View } from 'react-native';
import { Card, styles } from '../ui';
import { snapshotRows } from './summary-rows';
export { handoffTime } from './summary-rows';
export function HandoffSummary({ value }: {
  value: MobileHandoffSnapshot;
}) {
  return <Card>
    {snapshotRows(value).map(([label, value]) => <View key={label}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.text}>{value}</Text>
    </View>)}
  </Card>;
}
