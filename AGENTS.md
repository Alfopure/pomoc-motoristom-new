<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Deployment rule

This repository **is** the dispatch application. It was once a side copy built to try Telnyx without disturbing the VIPTel original; on 2026-09-21 the owner retired that original and moved the production hostname here.

It has separate production and test Supabase projects (Frankfurt) and its own Vercel project (region `fra1`).

Prefer the custom domain over any `*.vercel.app` address when configuring
anything external — a webhook, a callback, a bookmark. Renaming a Vercel
project changes its generated `*.vercel.app` alias and silently breaks whatever
pointed at the old one; a custom domain survives the rename.

### What this project owns

| | |
|---|---|
| Supabase production (`main`) | `ifpaeegaesdmljfkdvcn` |
| Supabase test (Preview and `dev`) | `nzpnqdstvkfncflgqlny` — Free organization `AlfoSystems` (`rwhghkvusmdnaexjvrum`) |
| Vercel | `pomoc-motoristom-dispatching` (`fra1`) |
| Hostnames | **`dispecing.linkapomoci.sk`** (production), `dispecing-test.vercel.app` |
| Canonical TEST hostname (`dev` Preview) | **`test.dispecing.linkapomoci.sk`** |
| Generated `dev` branch alias (fallback) | `pomoc-motoristom-dispatching-git-dev-alfopures-projects.vercel.app` |

Despite its name, `dispecing-test.vercel.app` is a production alias, not the isolated test environment. Use `https://test.dispecing.linkapomoci.sk` as the canonical TEST address and bind it exclusively to the `dev` branch's Preview deployment. Keep the generated `dev` alias as a fallback. Verify DNS, TLS, branch routing and the test database ref before treating a new domain mapping as ready; do not register real provider webhooks against test.

As of 2026-09-22, the canonical TEST hostname is active: authoritative DNS points to Vercel, TLS is valid, and Vercel maps it exclusively to the `dev` Preview deployment. The TEST Supabase Auth Site URL is `https://test.dispecing.linkapomoci.sk`; Production Auth remains unchanged. Domain mapping does not require `APP_BASE_URL`/`NEXT_PUBLIC_APP_URL` overrides or an application rebuild. Resolvers with an earlier negative DNS cache may need time to expire; the generated `dev` alias remains available meanwhile.

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
5. After merge, verify `https://test.dispecing.linkapomoci.sk` and the generated `dev` branch alias of this Vercel project.
6. Release production only through a pull request from `dev` into `main`. The production domain is `https://dispecing.linkapomoci.sk`.
   **Never publish by redeploying an older deployment.** `vercel redeploy <url>` rebuilds *that deployment's source*, not current `main` — on 2026-09-21 this silently rolled production back three commits while picking up an environment variable. To apply new environment variables, deploy `main` afresh.
7. Telephony (Telnyx) Supabase migrations and seed changes are in scope for this application, but apply them only when the user explicitly requests them and only against the explicitly authorized project: test `nzpnqdstvkfncflgqlny` or production `ifpaeegaesdmljfkdvcn`. Authorization to change test does not authorize production changes. Do not apply seed data on top of a copied snapshot. Do not deploy workers, schedulers, or listeners. The single allowed Vercel cron is `*/5 * * * *` -> `/api/telephony/cron` guarded by `CRON_SECRET`.
8. Newly built Preview deployments, including the `dev` branch, use test Supabase `nzpnqdstvkfncflgqlny`; production (`main`) uses `ifpaeegaesdmljfkdvcn`. The Vercel Development target was not changed by this isolation work: local developers must explicitly use test credentials and verify their effective project before writing. Test data is shared by all Preview branches. Existing deployment URLs retain their original environment until replaced; do not assume an old Preview is isolated.
9. The Free test project may pause after 7 days of low activity and requires manual restoration in the Supabase Dashboard. Follow [the test-environment runbook](docs/operations/test-environment.md) for restoration and data refresh. Keep live calls, SMS, email, AI and external integrations disabled in test; do not reconnect Preview to production as a fallback when test is unavailable.
