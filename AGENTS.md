<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Deployment rule

This repository **is** the dispatch application. It was once a side copy built to try Telnyx without disturbing the VIPTel original; on 2026-09-21 the owner retired that original and moved the production hostname here.

It has its own Supabase project (Frankfurt) and its own Vercel project (region `fra1`).

Prefer the custom domain over any `*.vercel.app` address when configuring
anything external — a webhook, a callback, a bookmark. Renaming a Vercel
project changes its generated `*.vercel.app` alias and silently breaks whatever
pointed at the old one; a custom domain survives the rename.

### What this project owns

| | |
|---|---|
| Supabase | `ifpaeegaesdmljfkdvcn` |
| Vercel | `pomoc-motoristom-dispatching` (`fra1`) |
| Hostnames | **`dispecing.linkapomoci.sk`** (production), `dispecing-test.vercel.app` |

`dispecing.linkapomoci.sk` belongs here. An earlier version of this file forbade touching it, which was correct while the original served it and is wrong now — the hostname moved with the owner's explicit instruction. If an agent reports it as an unexpected alias, that report is out of date, not the configuration.

### What this project must never touch

The retired VIPTel original: Supabase `sjcsrygkkmersoczpunh`, Vercel `pomoc-motoristom-dispatching-old`, `dev.dispecing.linkapomoci.sk`, and the previous telephony provider with its listener host.

That Supabase project is **not** dormant and must not be deleted. Alongside the
retired dispatch tables it holds a **live vehicle handover application** —
`rentals`, `rental_photos`, `vehicles`, with a `country` column and Polish
users — 1 385 handovers, 10 254 photo rows and 10 320 files in storage, last
written to on the day this was checked.

It is *not* the Watchdog application. Watchdog is a separate Supabase project
(`nkhrzdftvskgcwzenfnr`) holding feed scraping, alerts and notifications, and
nothing about vehicles. The two were confused once already; the names now say
which is which.

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
