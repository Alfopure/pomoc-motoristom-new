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

## Selected candidate for verification

`+1 234 233 2974` — US local number, Kent, Ohio. An exact authenticated inventory
query returned it as available with `sms` and `international_sms`, `best_effort=false`.
This is a candidate for the real reply-path test, not a verified production channel.
Availability can change until purchase.

| Item | Returned USD price |
| --- | --- |
| Number setup | 1.00 |
| Number monthly rental | 1.00 |
| US SMS monthly enablement, public pricing | 0.10 |
| Outbound SK rate deck: 4ka/O2/Orange/Telekom/other | 0.079 per segment |
| US long-code inbound platform usage | 0.004 per segment, plus applicable carrier fees |

Number costs came from `GET /v2/available_phone_numbers`. Usage prices came from
`GET /v2/pricing/products/messaging-outbound?filter[country_iso]=SK` and
`GET /v2/pricing/products/sms-api?filter[country_iso]=US`. The latter lists a zero
platform rate for international outbound in addition to the destination rate deck.
These are returned/public prices, not a promise of the final account invoice;
taxes, applicable carrier fees and any account-specific rate agreement still apply.

A Slovak customer would be replying to a US `+1` number, with the charge determined
by their own mobile plan. A successful API search does not prove that the exact
sender is preserved on their handset or that the return route works on each Slovak
mobile network. After purchase, inspect the actual messaging number's capability
flags and complete the user-designated handset test before advertising replies.

The user delegated selection of the number. A separate concrete purchase question
and a request for a designated test mobile are pending; the attached handoff plan
explicitly prohibited buying on an assumption or testing against customer phones.

References:

- [Number search API](https://developers.telnyx.com/api-reference/phone-number-search/list-available-phone-numbers)
- [Number coverage API](https://developers.telnyx.com/api-reference/country-coverage/get-coverage-for-a-specific-country)
- [Messaging number configuration](https://developers.telnyx.com/docs/messaging/messages/phone-number-configuration)
- [SMS pricing](https://telnyx.com/pricing/messaging)
- [Receiving SMS](https://developers.telnyx.com/docs/messaging/messages/receive-message)
