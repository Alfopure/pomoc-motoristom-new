<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Deployment rule

This repository **is** the dispatch application. It was once a side copy built to try Telnyx without disturbing the VIPTel original; on 2026-09-21 the owner retired that original and moved the production hostname here.

It has its own Supabase project (Frankfurt) and its own Vercel project (region `fra1`).

### What this project owns

| | |
|---|---|
| Supabase | `ifpaeegaesdmljfkdvcn` |
| Vercel | `pomoc-motoristom-new` (`fra1`) |
| Hostnames | **`dispecing.linkapomoci.sk`**, `dispecing-test.vercel.app`, `pomoc-motoristom-new.vercel.app` |

`dispecing.linkapomoci.sk` belongs here. An earlier version of this file forbade touching it, which was correct while the original served it and is wrong now — the hostname moved with the owner's explicit instruction. If an agent reports it as an unexpected alias, that report is out of date, not the configuration.

### What this project must never touch

The retired VIPTel original: Supabase `sjcsrygkkmersoczpunh`, Vercel `pomoc-motoristom-dispecing`, `dev.dispecing.linkapomoci.sk`, and the previous telephony provider with its listener host.

That Supabase project is **not** dormant. It also holds the Watchdog vehicle-handover application — 10 254 `rental_photos` rows and 10 320 files in storage — so it is somebody's live database, not an old copy waiting to be deleted.

Use the dev-first deployment workflow:

1. Start from the current `dev` branch.
2. Create a dedicated work branch.
3. Push the work branch and inspect its Vercel Preview URL. Preview runs the same build gate as production (`vitest run`, `typecheck`, `build`).
4. Open a pull request from the work branch into `dev`.
5. After merge, verify the `dev` branch alias of this Vercel project.
6. Release production only through a pull request from `dev` into `main`. The production domain is `https://dispecing.linkapomoci.sk`.
   **Never publish by redeploying an older deployment.** `vercel redeploy <url>` rebuilds *that deployment's source*, not current `main` — on 2026-09-21 this silently rolled production back three commits while picking up an environment variable. To apply new environment variables, deploy `main` afresh.
7. Telephony (Telnyx) Supabase migrations and seed changes are in scope for this copy, but apply them only when the user explicitly requests it and only against this copy's Supabase project. Do not deploy workers, schedulers, or listeners. The single allowed Vercel cron is `*/5 * * * *` -> `/api/telephony/cron` guarded by `CRON_SECRET`.
8. Development and Preview deployments use this copy's Supabase project, so every write is real for everyone testing on it.
