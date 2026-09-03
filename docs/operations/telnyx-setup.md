# Telnyx setup (resource identifiers)

Non-secret identifiers only. The API key, SIP passwords, WebRTC tokens and any regulatory or personal data must live in environment variables or the owner's private notes, never in this repository.

## Numbers (Bratislava fixed lines, no SMS, no Local Calling)

| Number | API string | Number ID | Status | Line |
|---|---|---|---|---|
| +421 2 324 087 00 | `+4210232408700` | 3040091148564563176 | active, **inbound only** | Neutrálna linka; cannot originate (malformed E.164 record, spike S3) |
| +421 2 324 087 18 | `+421232408718` | see `GET /v2/phone_numbers` | active | Allianz Assistance; current `TELNYX_DEFAULT_FROM_NUMBER` |
| +421 2 324 087 32 | `+421232408732` | see `GET /v2/phone_numbers` | active | Autoklub Slovakia Assistance |
| +421 2 324 087 60 | `+421232408760` | see `GET /v2/phone_numbers` | active | AXA Assistance CZ |
| +421 2 324 087 83 | `+421232408783` | see `GET /v2/phone_numbers` | active | Eurocross Assistance CR |

The first number's API string carries an extra leading `0` (provider quirk); always normalise inbound `to` through the E.164 helper before looking up the line.

## Production resources

| Resource | ID | Notes |
|---|---|---|
| Call Control application | 3040091293100279025 | `pomoc-motoristom-test`, Frankfurt anchor, webhook `/api/telephony/telnyx/webhook` on the production domain, failover on the `*.vercel.app` alias, `first_command_timeout_secs` 20, `webhook_timeout_secs` 10 |
| Credential connection (webphone) | 3040092094321394986 | `pomoc-motoristom-webrtc`, SRTP, Frankfurt anchor |
| WebRTC on-demand credential | b1665411-b7cd-4f3a-98bd-e86f1ebadf42 | `test-operator-1`; JWT via `POST /v2/telephony_credentials/{id}/token` |
| Outbound voice profile | 3040091178788717802 | EU27 whitelist, daily cap 20 USD, max destination rate 0.15 USD/min, concurrency 10 |
| Messaging profile | 4001a062-20cf-44ea-a956-6f272163907f | SK only, alpha sender `PomocMotor` |

## Dev / preview resources

| Resource | ID | Notes |
|---|---|---|
| Call Control application | 3040143024395913209 | `pomoc-motoristom-dev`, webhook on the `dev` branch alias |
| Credential connection | 3040143034428688382 | `pomoc-motoristom-webrtc-dev`, SRTP |
| Outbound voice profile | 3040143019555686391 | SK+CZ, daily cap 2 USD, concurrency 4 |
| Messaging profile | 4001a062-7f1b-45cc-9daf-5e110f66db17 | SK only, alpha sender `PomocMotor` |

## Webhook endpoints

| Environment | Voice | SMS |
|---|---|---|
| Production (`main`) | `https://dispecing-test.vercel.app/api/telephony/telnyx/webhook` (failover: the project's default `*.vercel.app` alias) | `https://dispecing-test.vercel.app/api/sms/telnyx/webhook` |
| Development (`dev` branch alias) | `https://pomoc-motoristom-new-git-dev-alfopures-projects.vercel.app/api/telephony/telnyx/webhook` | `https://pomoc-motoristom-new-git-dev-alfopures-projects.vercel.app/api/sms/telnyx/webhook` |

Once the `test.dispecing.linkapomoci.sk` CNAME exists, the production URLs move to that domain and the `*.vercel.app` alias stays the failover.

The production outbound voice profile whitelists all EU27 destinations; the development profile only SK and CZ. Both keep a daily spend cap and a per-minute destination price ceiling.

## Environment mapping

`TELNYX_CALL_CONTROL_APP_ID`, `TELNYX_CREDENTIAL_CONNECTION_ID`, `TELNYX_OUTBOUND_VOICE_PROFILE_ID` and `TELNYX_MESSAGING_PROFILE_ID` take the production IDs on `main` and the dev IDs on Preview and `dev`. `TELNYX_DEFAULT_FROM_NUMBER` is `+421232408718`: spike S3 showed that the first number cannot originate calls because of the malformed E.164 record Telnyx stores for it (see [`telnyx-runbook.md`](./telnyx-runbook.md)). See `.env.example` for the full `TELNYX_*` block.

Operational procedures for these resources are in [`telnyx-runbook.md`](./telnyx-runbook.md).
