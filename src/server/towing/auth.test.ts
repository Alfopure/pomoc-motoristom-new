import { describe, expect, it } from 'vitest';
import type { TowingCapability, TowingMember } from '@/domain/towing/types';
import { towingLoginDestination } from './auth';

function actor(capabilities: TowingCapability[]): TowingMember {
  return { id: 'synthetic-member', userId: 'synthetic-user', organizationId: 'synthetic-org', displayName: 'Synthetic field member', roles: [], capabilities, active: true, version: 1 };
}

describe('verified towing module destinations', () => {
  it('keeps office and driving priority and gives deliver-only membership its own web destination', () => {
    expect(towingLoginDestination(actor(['operate', 'drive', 'deliver']))).toBe('/zakazky');
    expect(towingLoginDestination(actor(['bill', 'deliver']))).toBe('/zakazky');
    expect(towingLoginDestination(actor(['drive', 'deliver']))).toBe('/vodic');
    expect(towingLoginDestination(actor(['drive']))).toBe('/vodic');
    expect(towingLoginDestination(actor(['deliver']))).toBe('/moje-jazdy');
    expect(towingLoginDestination(actor([]))).toBeNull();
  });
});
