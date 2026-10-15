import { CallActionError } from './service-errors';
import { readMeta, telnyxSipUri, type LegRow, type NativeHoldGuard, type SessionRow } from './state/types';
import type { SessionRunnerDeps } from './session-runner';
/** Media authority is narrower than originating/accepted-leg cleanup authority. */
export async function assertNativeHoldAuthority(deps: Pick<SessionRunnerDeps, 'admin' | 'organizationId' | 'environment' | 'now'>, session: SessionRow, identity: Omit<NativeHoldGuard, 'customerControlId'> & {
    customerControlId?: string;
}, knownLegs?: LegRow[]) {
    const deviceResult = await deps.admin.from('motorist_operator_mobile_devices').select('*')
        .eq('organization_id', deps.organizationId).eq('profile_id', identity.profileId).eq('environment', deps.environment).maybeSingle();
    if (deviceResult.error)
        throw new CallActionError('Telefón sa nepodarilo overiť.', 503, 'native_hold_read');
    const device = deviceResult.data;
    if (!device?.sip_username || device.device_session_id !== identity.deviceSessionId || ['error', 'unregistered'].includes(device.registration_state)) {
        throw new CallActionError('Telefón už nemá túto reláciu.', 409, 'native_lease_stale');
    }
    const meta = readMeta(session);
    if (session.organization_id !== deps.organizationId || meta.environment !== deps.environment || session.writer_contract !== 2 ||
        !['inbound', 'outbound'].includes(session.direction) || session.answered_by_profile_id !== identity.profileId ||
        !session.answered_at || session.ended_at || session.termination_requested_at || !['talking', 'held'].includes(session.state)) {
        throw new CallActionError('Hovor nie je dostupný na podržanie.', 409, 'native_hold_unavailable');
    }
    const accepted = meta.accepted_device_legs?.[identity.profileId] ?? meta.answered_leg_call_control_id;
    if (!accepted || accepted !== identity.callControlId || meta.answered_leg_call_control_id && meta.answered_leg_call_control_id !== accepted) {
        throw new CallActionError('Hovor nepatrí tomuto telefónu.', 403, 'native_hold_endpoint');
    }
    let legs = knownLegs;
    if (!legs) {
        const result = await deps.admin.from('motorist_call_legs').select('*').eq('organization_id', deps.organizationId).eq('session_id', session.id);
        if (result.error)
            throw new CallActionError('Účastníka hovoru sa nepodarilo overiť.', 503, 'native_hold_read');
        legs = result.data ?? [];
    }
    const own = legs.find(leg => leg.telnyx_call_control_id === accepted && leg.profile_id === identity.profileId && leg.role === 'operator' &&
        leg.to_number === telnyxSipUri(device.sip_username ?? '') && Boolean(leg.answered_at) && !leg.ended_at);
    if (!own)
        throw new CallActionError('Hovor nepatrí tomuto telefónu.', 403, 'native_hold_endpoint');
    const customers = legs.filter(leg => leg.role === 'customer');
    const customer = session.customer_leg_id ? customers.find(leg => leg.id === session.customer_leg_id) : customers.length === 1 ? customers[0] : null;
    if (!customer?.telnyx_call_control_id || !customer.answered_at || customer.ended_at || identity.customerControlId && identity.customerControlId !== customer.telnyx_call_control_id) {
        throw new CallActionError('Druhý účastník hovoru nie je pripojený.', 409, 'native_hold_unavailable');
    }
    return { own, customer };
}
