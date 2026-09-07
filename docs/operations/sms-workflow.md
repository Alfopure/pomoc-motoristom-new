# SMS editor, delivery and inbox

The SMS entry in the dashboard opens without a case. Case actions open the same
editor with an explicit, visible case. Templates require a saved case and its
canonical `motorist_contacts` phone. Custom SMS can be sent without a case.

## Preparation and sending

`POST /api/sms/prepare` is authenticated, organization scoped and read only. It
returns a 30-minute signed draft with the recipient, sender, template variables
and (for location requests) the real opaque URL. Preparing never creates a case,
SMS row or location link. The URL uses the reachable alias serving the editor;
it does not depend on the pending custom domain's DNS.

The final text is editable. Six versioned templates cover location, case receipt,
technician departure, delay, callback and tow destination. Departure needs an
explicit confirmation and a manually entered current ETA. Template facts, the
server-generated URL, callback number, channel-specific reply notice, text length and segment
limit are checked again on send. The editor counts GSM-7 extensions and UTF-16
surrogate pairs. Removing diacritics is an explicit visible edit; no price is
estimated.

`POST /api/sms/send` and `POST /api/cases/[id]/sms` both require the prepared draft,
its proof and final `message`. The old template-only request is rejected. Both
routes use the same dispatcher/senior_dispatcher/manager/admin role gate, CSRF
check and authenticated author. The MAC uses the existing server-only Supabase
service secret with a dedicated domain prefix; no additional environment key is
needed. Changing the saved contact invalidates an unsent preview.

One request UUID identifies one intentional send. The existing unique index on
`(organization_id, provider, idempotency_key)` chooses the only process allowed
to call Telnyx. The stored fingerprint binds the entire draft and exact text.
Retries return the durable result, including failed attempts, without another
provider call. After an ambiguous network/provider failure the editor preserves
the request and prevents a new send from that draft. Check the Telnyx message
records before manually starting a separate message. Usage-accounting failures
cannot turn an accepted SMS into a transport failure.

## History and location

`GET /api/sms` provides paginated shared history; `caseId` filters those same
records. It includes SMS without a case, exact text, author, recipient, sender,
template, error, time and status. The editor and independent case-history panel
refresh visible history every ten seconds. Delivered means delivery, not read.
`delivery_unconfirmed` is shown distinctly from normal sent status.

Signed, matching-profile Telnyx receipts retain workflow metadata under
`raw_payload` and place the provider event under `provider_event`. Conditional
updates retry competing writes and never downgrade a delivery status. A receipt
that arrives before the send response's provider ID is stored returns 503 for
Telnyx retry. Foreign profiles cannot update rows.

A location request activates its link only during the explicit send and expires
24 hours later. An intentional new request creates an independent link; earlier
links remain usable until consumed, revoked or expired. A definite send rejection
revokes its new link. History separately shows request state, submission time,
accuracy and a map link. GPS is supplemental until the dispatcher clicks
**Použiť ako miesto incidentu**; this action is disabled while local case edits
are unsaved.

The additive SQL proposal [location-submission-once.sql](sql/location-submission-once.sql)
serializes concurrent GPS submissions with a row lock and commits link consumption
with the accepted submission. It has been tested on a local PostgreSQL instance
for concurrency, expiry, revocation, organization mismatch and rollback. Applying
it to `ifpaeegaesdmljfkdvcn` requires the separate explicit approval in AGENTS.md.
The application handles its conflict error as 410 and remains compatible before
it is applied. Until then, the existing database does not enforce atomic single
use under concurrent submissions. No seed changes are needed.

## Receiving SMS and explicit assignment

`message.received` uses the existing Ed25519 verification of the original body
and timestamp. The configured messaging profile and exact receiving number must
match. A single insert stores the canonical E.164 endpoints, provider message ID,
text, event and received time before returning 2xx. A 1.5-second database deadline
leaves room for the provider's acknowledgement timeout. Failed or uncertain writes
return a retryable response. The existing unique idempotency index deduplicates
`telnyx:inbound:<profile>:<provider-message-id>`; a duplicate never resets assignment
or read state. No schema migration is needed for this implementation.

Every incoming SMS begins with `case_id = null` and `status_detail = received_unread`.
The inbox filters all/unread/unassigned messages. Its read state is shared by the
dispatch team, with the acting profile and time recorded under `raw_payload.inbox`.
Case and dispatcher assignment are explicit per message. A version check prevents
a dispatcher from silently replacing a colleague's concurrent edit. Cases and
active dispatchers are checked against the authenticated actor's organization.
The provider event remains unchanged. Assignment never changes the case's contact
or location. A newly created case can be selected when the SMS window is reopened.

`GET /api/sms/inbox` lists 50 messages with pagination; `?summary=true` provides the
unread count for the dashboard badge. `GET /api/sms/inbox/[id]` shows a paginated
conversation scoped to the two exact phone numbers, organization and messaging
profile. Messages in that conversation can belong to different cases; grouping
does not assign them. `PATCH /api/sms/inbox/[id]` updates read state or explicit
assignment. All endpoints use the same SMS roles, session guard and write CSRF
check. Visible inbox data and the dashboard badge refresh every ten seconds.

**Napísať odpoveď** opens the same verified editor with `replyToMessageId`. The
recipient is the actual sender of that incoming SMS, even when the assigned case
has another primary contact. The server verifies both endpoints, profile and
current case assignment again before sending. Replies use the receiving number;
they cannot silently fall back to the alphanumeric sender. An unresolved prior
send cannot be overwritten with a new inbox reply. Assigned incoming messages also
appear in the case's shared SMS history. Media metadata is retained, but attachment
previews are outside this SMS rollout.

## Activating a receiving number

An authenticated inventory check on 2026-09-07 confirmed that all eight existing
Slovak numbers have `features.sms = null`. The two known profiles still use
`PomocMotor`. API access is available through this copy's Vercel configuration;
it is no longer a blocker. See the [number selection audit](sms-number-selection.md)
for the candidate, prices and remaining live-network uncertainty.

1. Purchase only after explicit purchase authorization. Recheck availability and
   price immediately before ordering. Do not change the existing voice lines.
2. Confirm the purchased number's `domestic_two_way`, `international_inbound` and
   `international_outbound` SMS capabilities, and assign it to this environment's
   messaging profile. Existing outgoing-only traffic remains usable.
3. Configure `TELNYX_SMS_FROM_NUMBER`, `TELNYX_SMS_ORGANIZATION_ID` and the existing
   messaging profile/public key for this copy. With no valid binding, incoming
   events return `inbound_not_enabled` (503). No worker or scheduler is required.
4. Keep `TELNYX_SMS_REPLIES_VERIFIED=false`. Set `TELNYX_SMS_TEST_RECIPIENT` only to
   the user's explicitly designated test mobile. Only that recipient uses the
   numeric sender; other traffic retains `PomocMotor` and the non-reply notice.
5. Follow the dev-first Preview -> dev -> main PR workflow. Test send -> handset
   displaying the exact numeric sender -> reply -> durable row -> inbox ->
   explicit case assignment -> reply from the same number. Confirm actual costs
   from the resulting message records. Do not use a customer phone for testing.
6. Enable `TELNYX_SMS_REPLIES_VERIFIED=true` only after that path is verified, and
   clear the pilot recipient. Templates then truthfully invite replies. One number
   belongs to only one messaging profile; when moving it from dev to production,
   retire the dev binding and verify the production webhook and profile together.

GPS received through the location-sharing web link is independent of SMS replies.

Official references checked for this change:

- [Telnyx sender types](https://developers.telnyx.com/docs/messaging/getting-started/choosing-your-sender-type)
- [Receiving messages](https://developers.telnyx.com/docs/messaging/messages/receive-message)
- [Signed webhooks and retries](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks)
- [Encoding and segments](https://developers.telnyx.com/docs/messaging/messages/message-encoding)
