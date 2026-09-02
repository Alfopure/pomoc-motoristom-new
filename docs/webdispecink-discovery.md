# WebDispecink Discovery

## Purpose

Use the read-only discovery script to verify WebDispecink API access before building production sync.

The script calls only:

- `_login`
- `_getCarsList2`
- `_getAllCarsPosition`

It does not write to Supabase or WebDispecink.

## Local Setup

Put real credentials in `.env.local`, which is ignored by git:

```env
WEBDISPECINK_COMPANY_CODE=
WEBDISPECINK_USERNAME=
WEBDISPECINK_PASSWORD=
WEBDISPECINK_ACTIVE_ONLY=1
WEBDISPECINK_GEOCODE=0
WEBDISPECINK_SHOW_COORDINATES=0
WEBDISPECINK_REQUEST_TIMEOUT_MS=12000
```

Then run:

```bash
pnpm webdispecink:discover
```

`WEBDISPECINK_SHOW_COORDINATES=0` hides exact GPS coordinates in logs. Set it to `1` only for a local debugging run where exact coordinates are needed.

## Expected Result

The script prints:

- login status,
- active vehicle count,
- current position count,
- car ID, license plate, online/disabled flags,
- current position timestamp and speed when a position exists.

If credentials fail, `_login` returns a non-OK result and the script stops before calling vehicle endpoints.

## App Sync

The app sync is server-side only. It uses the same WebDispecink credentials from server env and writes normalized data into Supabase:

- provider staging: `motorist_fleet_provider_vehicles`,
- live GPS location: one mutable `motorist_locations` row per provider vehicle,
- mapped fleet asset GPS: `motorist_fleet_assets.current_location_id`, `last_seen_at`, `source_system`, `external_id`, `location_source`, `metadata.gps`.

Internal endpoint:

```http
POST /api/integrations/fleet/webdispecink/sync
Content-Type: application/json

{"mode":"positions"}
```

Production cron endpoint:

```http
GET /api/integrations/fleet/webdispecink/sync
Authorization: Bearer <CRON_SECRET>
```

The GET endpoint always runs `positions` only. It is intended for Vercel Cron and must be protected by `CRON_SECRET` or `WEBDISPECINK_SYNC_TOKEN`.
Set `WEBDISPECINK_SYNC_ENABLED=false` while the production database migration is not applied yet; the cron endpoint will then return a skipped response without calling WebDispecink.

Supported modes:

- `positions`: calls `_getAllCarsPosition`,
- `catalog`: calls `_getCarsList2`,
- `full`: calls both.

Recommended schedule for roughly 10 vehicles:

- `positions` every 60 seconds,
- `full` or `catalog` every 12 hours or manually.

Vercel Hobby projects cannot run a minutely cron. Production uses `.github/workflows/webdispecink-sync.yml` instead: GitHub Actions runs every 5 minutes and polls the positions endpoint 5 times with 60-second sleeps. Configure the repository secret `WEBDISPECINK_SYNC_TOKEN` with the same value as the Vercel `CRON_SECRET` / `WEBDISPECINK_SYNC_TOKEN`. GitHub scheduled workflows are best-effort, so this is suitable for operational GPS refresh but not a hard 60-second SLA.

The manual POST sync endpoint requires a logged-in manager/admin. For a cron or worker, set `CRON_SECRET` or `WEBDISPECINK_SYNC_TOKEN` and send it as `Authorization: Bearer ...` or `x-webdispecink-sync-token`.

## Mapping

The integration settings panel shows WebDispecink provider vehicles. Unmapped vehicles can be:

- linked to an existing fleet asset,
- imported as a new tow truck or replacement car.

The sync never overwrites internal availability, branch assignment, occupancy, driver assignment, or case state. WebDispecink is treated as a GPS source only.
