export function clientAssetScanMatchesTarget(sourceStatus, targetStatus) {
  return sourceStatus === 1 && targetStatus === 0;
}
