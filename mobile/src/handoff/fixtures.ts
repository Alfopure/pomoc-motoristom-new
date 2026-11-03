import type { MobileCaseHandoffs, MobileHandoffMutation } from '../../../src/lib/mobile-api';
export const caseId = '11111111-1111-4111-8111-111111111111', grantId = '22222222-2222-4222-8222-222222222222', commandId = '33333333-3333-4333-8333-333333333333';
export const scope = {
  ok: true as const, apiVersion: 1 as const, environment: 'test' as const, profileId: '44444444-4444-4444-8444-444444444444', checkedAt: '2026-10-11T23:00:00Z'
};
export const origin = 'https://test.dispecing.linkapomoci.sk';
export const context = (): MobileCaseHandoffs => ({
  ...scope, caseId, enhanced: true, previewVersion: 'a'.repeat(64), preview: {
    schemaVersion: 3, caseNumber: 'MOCK-42', action: 'Odťah', contact: { name: 'MOCK klient', phone: '+421900000000' }, vehicle: {
      make: 'Škoda', model: 'Fabia', plate: 'MOCK42', color: 'Biela', driveable: false, conditionFlags: ['locked']
    }, pickup: { address: 'MOCK miesto', lat: 0, lng: 0 }, destination: null, assistance: { name: 'MOCK asistencia', reference: 'REF42' }, replacement: {
      needed: false, category: 'wagon', requestedType: 'Rodinné', preferences: ['automatic'], status: 'not_needed', deliveryPlace: 'MOCK doručenie', vehicle: null
    }, incident: { description: 'MOCK porucha', passengersCount: 0, access: 'MOCK prístup' }, caseCreatedAt: scope.checkedAt, firstCallAt: null
  }, handoffs: []
});
export const receipt = (): MobileHandoffMutation => ({
  ...scope, kind: 'mutation', caseId, handoffId: grantId, commandId, action: 'issue', committedRevision: 1, currentRevision: 1, refreshRequired: true, link: {
    status: 'available', url: origin + '/handoff#token=' + 'a'.repeat(43), expiresAt: '2099-10-12T23:00:00Z', currentRevision: 1
  }
});
export const withGrant = (): MobileCaseHandoffs => ({ ...context(), handoffs: [{
      id: grantId, status: 'offered', revision: 1, publishedVersion: 1, recipientName: 'MOCK kolega', recipientPhone: '+421900000001', expiresAt: '2099-10-12T23:00:00Z', createdAt: scope.checkedAt, openedAt: null, eta: null, createdBy: null, publishedAt: scope.checkedAt, canRenew: true, recoverable: true, published: context().preview, events: []
    }] });
