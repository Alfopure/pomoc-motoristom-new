# Fast call startup and retained phone recovery — 13 September 2026

Target: the isolated Telnyx copy at https://dispecing-test.vercel.app/.

## Evidence and intended behavior

The settings audit found seven active lines with no explicit announcements configuration. The former inbound default made those calls wait for a greeting before operator routing. Allianz already had startup announcements explicitly disabled, so this finding does not explain every earlier delay. No database update is needed: new unconfigured calls now route without the introduction. Explicit opt-in remains supported in the editor and server, while a call retains the configuration frozen when it began. Disabling the introduction also disables automatic capture; it cannot start recording silently.

The browser minted replacement JWTs but did not apply them to an existing SDK connection. Refresh now authenticates the retained client using the SDK login callback, with serialized requests and protection against late responses from superseded connections. The expiring-token warning triggers a bounded refresh. A healthy active call remains controllable throughout token renewal.

Previously a socket close caused application disconnect, which purged active SDK calls and disabled the SDK's own reconnect. The application now allows the installed SDK to recover its connection and peer, retaining the current call. Recovery never becomes a second ringing offer or a second application answer. Late events from the old call object cannot terminate a recovered replacement. Intentional hangup, confirmed server termination and operator takeover remain definitive. Recovery has a finite watchdog and exhausted/fatal failures remain visible.

An installed mobile PWA keeps a foreground phone registered for two minutes after the last call/request completes. The next call can reuse it. Heartbeats do not extend that deadline. A hidden idle phone releases registration; an active call or pending operator request remains protected. Returning to the foreground alone does not start a new phone registration.

## SDK contract and scope

The recovery behavior was checked against installed `@telnyx/webrtc` 2.27.10, the matching official source and the [Telnyx SDK lifecycle reference](https://developers.telnyx.com/docs/development/webrtc/js-sdk/reference/telnyxrtc), including token warnings, login callbacks and recovered-call identity. Trickle ICE stays enabled. ICE prefetch stays at the installed SDK default. No codec, provider region, caller ID or provider recording setting is changed without verified account evidence.

Main webhook effects still complete before a success acknowledgement. Moving them to an unawaited callback would risk delayed or lost immediate routing after process termination; the existing five-minute recovery cron is not a prompt delivery mechanism. Existing after-response replay and housekeeping remain in place, as do command ownership fences, idempotency and exact-call termination.

This release changes application code only. It does not migrate or seed the shared database, change live line metadata, or deploy a worker or scheduler. Automated browser and SDK tests use isolated fixtures, and release smoke tests cannot create authenticated calls or SMS.

## Verification and release

Regression coverage includes immediate routing from empty/legacy line settings, preserved explicit greetings and recording notices, frozen per-call policy, token-refresh races, transient connection/media recovery, deliberate termination during recovery, and mobile standby deadlines. The local final gate passed 3,778 Vitest tests (2 existing skips), 43 Node tests (1 existing skip), TypeScript and changed-file ESLint. There are 65 passing browser scenarios: 59 phone scenarios and 6 announcements settings scenarios. The local production build also passed; Vercel repeats the full test/type/build gate on each exact release commit. The release pull requests record exact deployment identities for the work preview, dev alias and production alias.

Deployed smoke tests verify the exact deployment on mobile and desktop, normal pinned Next.js navigation, assets, public health, and authentication/signature boundaries. They do not measure real carrier setup time or two-way audio. A fresh real call after release is required to compare actual inbound, outbound, transfer and termination timing with the preceding release.
