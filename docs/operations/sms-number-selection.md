# SMS number selection — 2026-09-07

Scope: only `Alfopure/pomoc-motoristom-new`, Vercel project
`prj_DN3smSO1EbGowAmw3nHLQUYoSVJG` and Supabase `ifpaeegaesdmljfkdvcn`.
No original production resources were accessed. No number has been bought or
reserved, and no live SMS has been sent for this audit.

## Authenticated findings

The cloud workspace has no local Telnyx credentials. The user's existing Vercel
CLI login on the Mac had expired and was successfully refreshed with `vercel whoami`.
The preview-scoped Telnyx key of this Vercel project was then used in memory on the
Mac for read-only Telnyx API requests. Neither credentials nor decrypted environment
values were printed, copied into this workspace, or committed.

- `GET /v2/phone_numbers`: eight active Slovak local numbers, all used by this
  copy's existing voice application, none assigned to a messaging profile.
- `GET /v2/messaging_phone_numbers`: all eight have `sms: null` and `mms: null`.
- Production messaging profile `4001a062-20cf-44ea-a956-6f272163907f` is enabled,
  uses alpha sender `PomocMotor`, allows destination `SK`, and posts to
  `https://dispecing-test.vercel.app/api/sms/telnyx/webhook`.
- Dev profile `4001a062-7f1b-45cc-9daf-5e110f66db17` is also enabled, uses the
  same alpha sender and SK allowlist, and posts to the dev branch alias.
- `GET /v2/country_coverage/countries/SK` lists voice/fax/emergency/local-calling
  capabilities and no SMS. This is a number-coverage result, separate from the
  ability to send messages to Slovak mobile numbers.
- Country coverage marks `international_sms: true` for US/PR/VI resources.
  Queried European SMS resources, including GB and PL, do not have that flag.
  This alone must not be interpreted as a complete carrier-by-carrier inbound
  guarantee or a proof that every European resource cannot receive any foreign SMS.

## Current decision

The user explicitly rejected a US number and instructed us to finish the work
possible without it. The earlier US candidate is withdrawn. Its purchase question
and associated live-test request are closed; no purchase or reservation took place.
No replacement number is selected or authorized for purchase in this rollout.

The receiving backend, inbox, explicit case assignment and reply workflow are
implemented. Incoming replies remain inactive, and the inbox states this visibly
instead of showing only an empty message list. Outbound `PomocMotor` SMS,
templates, delivery history and web-based location requests remain available.

A future receiving number must be outside the US and support the actual reply
path from Slovak mobile networks. European search results lacking the
`international_sms` flag have not established such a path. Do not assume that
this proves all non-US numbers are unsuitable. Provider capability confirmation
and a user-designated handset test are still required before activation.

References:

- [Number search API](https://developers.telnyx.com/api-reference/phone-number-search/list-available-phone-numbers)
- [Number coverage API](https://developers.telnyx.com/api-reference/country-coverage/get-coverage-for-a-specific-country)
- [Messaging number configuration](https://developers.telnyx.com/docs/messaging/messages/phone-number-configuration)
- [SMS pricing](https://telnyx.com/pricing/messaging)
- [Receiving SMS](https://developers.telnyx.com/docs/messaging/messages/receive-message)
