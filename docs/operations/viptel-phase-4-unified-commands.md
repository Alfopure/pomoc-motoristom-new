# VIPTel Phase 4 — unified commands and transfers

Phase 4 uses the existing `motorist_telephony_commands` table. It does not add a Supabase migration.

## Runtime flow

1. An authenticated operator requests a call, hangup, transfer, or queue availability change.
2. The Vercel route verifies the actor, owned source extension, live call, and destination when applicable.
3. The route inserts a durable command and returns HTTP `202` with its id.
4. The Hetzner VIPTel listener claims queued commands in creation order.
5. Call actions use the documented VIPTel WebSocket protocol. Queue add/remove/pause/unpause uses VIPTel REST because the WebSocket API documents those as confirmation events, not outbound actions.
6. The listener marks success only after a matching provider event. The browser polls the command row and does not optimistically change the UI.

Browser SIP calls remain direct SIP calls. Before the SIP INVITE, the browser creates an authenticated `call.create` intent in the same table. The listener confirms that intent from the matching `call.begin` event, so direct browser and PBX callback calls share actor audit and provider confirmation without creating a duplicate call.

## Safety rules

- A source extension must belong to the authenticated profile.
- Hangup and redirect require a currently active, stored call owned by that profile.
- A station transfer target must have a canonical profile assignment, current VIPTel registration, active unpaused queue membership, and no active call.
- A manually entered external target is normalized to a numeric VIPTel dial target. Short extension-like input is rejected so it cannot bypass station availability validation.
- UI success requires `confirmed_by_event`.
- Commands older than their safe send window are failed instead of being replayed unexpectedly.
- A command that was sent but not confirmed is not retried automatically; after the confirmation timeout it is marked failed with `deliveryUncertain=true`. Refresh provider state before repeating it.
- Previously accepted Phase 1–3 audit rows are not modified by the Phase 4 timeout sweep.

## Deployment order

The web app and Hetzner listener must run the same Phase 4 commit. A Phase 4 web deployment with the Phase 3 listener will enqueue commands but cannot consume them.

1. Run lint, typecheck, all tests, production web build, worker build, and listener build.
2. Deploy the web application from the reviewed commit.
3. Build and activate the Hetzner background release from the exact same commit using the existing isolated background activation procedure.
4. Verify the listener heartbeat and `viptel_ws_status=connected` before using call controls.
5. Keep `telephony.viptel.reconcile` enabled.

## Live acceptance checks

Use assigned test extensions and test phone numbers only.

1. **PBX callback call:** create a call in Klapka mode. The UI must move from waiting to confirmed only after `call.create_response`; the command stores the authenticated operator.
2. **Browser SIP call:** create a browser call. Exactly one real call must start, the browser intent must confirm from `call.begin`, and history must use the same stored call.
3. **Queue state:** set Available, Pause, then Offline. Each command must confirm from its exact queue/member event and `Voľní` must refresh afterward.
4. **Hangup:** end one browser call and one physical-phone call. Each command must confirm from `call.end`; if the listener connected after the call began, VIPTel may correctly reject API hangup as `Call not found`.
5. **Transfer:** while extension A owns an active or ringing call, transfer to listed extension B and to one approved external test number. B must be registered, available, and idle. The UI remains pending until provider confirmation, the command keeps the original `call_id`, and the case/history must not split. Verify both `call.begin` confirmation and the documented `queue.left` event when redirecting directly from a queue.
6. **Target race:** pause or occupy B after opening the target list but before confirming. The redirect route must reject B and require a refresh.
7. **Listener restart:** stop the listener after a command is marked sent. On restart, it must not blindly resend the ambiguous command.
8. **Authorization:** attempt a call control with another operator's call id or source extension. The API must return `403`.

## Provider/PBX requirements

The VIPTel WebSocket account needs permission for `call.create`, `call.hangup`, and `call.redirect`. No PBX Manager layout change is required by the code, but live testing must confirm those permissions. VIPTel documents that hangup can control only calls which began while the current API connection was active; a listener restart during a call therefore intentionally produces a safe error instead of pretending the action succeeded.
