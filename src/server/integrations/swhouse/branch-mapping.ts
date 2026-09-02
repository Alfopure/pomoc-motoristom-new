import "server-only";

/**
 * Mapovanie SWHouse pobočky (lasFilialId, fixných 1..10) na naše motorist_branches.id.
 * JEDINÁ autorita = explicitný SWHOUSE_BRANCH_MAP. Žiadny fuzzy name-match (riziko priradenia
 * počtov na zlú pobočku). Nenamapované lasFilialId → null ("nepriradené", neprepíše pobočku).
 */
export function mapSwhouseBranch(branchMap: Record<string, string>, lasFilialId: number | null): string | null {
  if (lasFilialId == null) {
    return null;
  }
  return branchMap[String(lasFilialId)] ?? null;
}

/**
 * Cieľové branch id z mapy, ktoré nezodpovedajú žiadnej existujúcej pobočke (stale konfigurácia).
 * Použiteľné na warning; neovplyvňuje agregáciu.
 */
export function findStaleBranchTargets(branchMap: Record<string, string>, knownBranchIds: Iterable<string>): string[] {
  const known = new Set(knownBranchIds);
  const stale: string[] = [];
  for (const target of Object.values(branchMap)) {
    if (!known.has(target)) {
      stale.push(target);
    }
  }
  return stale;
}
