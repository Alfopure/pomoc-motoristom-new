# SMS editor and delivery

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
server-generated URL, callback number, non-reply notice, text length and segment
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

## Incoming SMS is not active

The current sender remains alphanumeric. No suitable receiving number has been
verified through an authenticated Telnyx inventory query in this workspace; it
has no Telnyx API credentials. No number was purchased and no live SMS was sent.
Inbound events for the configured profile return `inbound_not_enabled` (503),
not a false acknowledgement of storage. Do not route a receiving number to this
endpoint until durable inbound ingestion is implemented and tested.

A later receiving rollout needs a verified number supporting replies from Slovak
mobile networks, confirmed profile/sender configuration and pricing, durable
inbound deduplication, unassigned conversations, explicit case assignment and a
user-designated test phone for the complete send/reply/UI path. GPS received via
the web link is independent of receiving SMS replies.

Official references checked for this change:

- [Telnyx sender types](https://developers.telnyx.com/docs/messaging/getting-started/choosing-your-sender-type)
- [Receiving messages](https://developers.telnyx.com/docs/messaging/messages/receive-message)
- [Signed webhooks and retries](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks)
- [Encoding and segments](https://developers.telnyx.com/docs/messaging/messages/message-encoding)
