# Security Model

## Data Classes

Sensitive data includes phone numbers, names, addresses, vehicle registration numbers, call recordings, transcripts, AI summaries, location data, and case notes. These records must be protected by authentication, organization scoping, role policies, and audit logging.

## Roles

- `dispatcher`: handles calls, creates and updates cases, sends operational SMS.
- `senior_dispatcher`: dispatcher permissions plus queue/capacity oversight and selected corrections.
- `manager`: reporting access and read access to operational history.
- `admin`: organization configuration, integrations, branches, users, and security settings.

Recordings, transcripts, AI scoring, integration credentials, and audit logs need stricter access than ordinary case fields.

## Supabase RLS

Default policy:

- authenticated users can only access rows for their organization,
- inactive profiles have no app access,
- service-role jobs can write integration events and reconciliation results,
- admin-only tables require admin role checks.

Realtime should expose only active operational projections needed by the UI, not every raw integration event.

## Secrets

Never expose provider credentials to the browser. Telnyx, Google, SMS, fleet, AI, and Supabase service-role keys stay server-side. The browser phone receives only a short-lived WebRTC token. The committed `.env.example` lists variable names only.

## Audit Requirements

Write audit entries for:

- creating, assigning, closing, rejecting, or cancelling cases,
- linking or unlinking calls and cases,
- sending SMS,
- opening or downloading recordings/transcripts,
- changing pobočky, cenníky, fleet assets, or integration settings,
- changing user roles or organization settings.

Recording reads are recorded in `motorist_audit_log` before content is returned.
`telephony.recording.audio.read`, `telephony.recording.detail.read` and
`telephony.recording.own_review.read` identify the verified actor, organization,
resource and source revision. Repeated ranges or detail polling share one durable
event per actor/resource/revision and UTC minute; this records authorized access,
not exact playback counts or completed downloads. The row ID correlates that
access window. Audit payloads contain no transcript text, audio URLs or tokens.
If the audit cannot be confirmed, content reads return 503; rejected/redacted
requests are not reported as successful content access.

## Retention and GDPR Notes

Retention is not final until legal review. The foundation assumes retention policies will be configured for recordings, transcripts, SMS, and case history. The schema should make deletion, export, and restricted access possible without redesign.
