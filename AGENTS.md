<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Deployment rule

This repository **is** the dispatch application. It was once a side copy built to try Telnyx without disturbing the VIPTel original; on 2026-09-21 the owner retired that original and moved the production hostname here.

It has separate production and test Supabase projects (Frankfurt) and separate production and stable TEST Vercel projects (region `fra1`).

Prefer the custom domain over any `*.vercel.app` address when configuring
anything external — a webhook, a callback, a bookmark. Renaming a Vercel
project changes its generated `*.vercel.app` alias and silently breaks whatever
pointed at the old one; a custom domain survives the rename.

### What this project owns

| | |
|---|---|
| Supabase production (`main`) | `ifpaeegaesdmljfkdvcn` |
| Supabase test (Preview and `dev`) | `nzpnqdstvkfncflgqlny` — Free organization `AlfoSystems` (`rwhghkvusmdnaexjvrum`) |
| Vercel production | `pomoc-motoristom-dispatching` (`main`, Production, `fra1`) |
| Vercel stable TEST | `pomoc-motoristom-test` (`dev`, Production, `fra1`) |
| Hostnames | **`dispecing.linkapomoci.sk`** (production), `dispecing-test.vercel.app` |
| Canonical TEST hostname (dedicated TEST project) | **`test.dispecing.linkapomoci.sk`** |
| Restricted `dev` Preview alias | `pomoc-motoristom-dispatching-git-dev-alfopures-projects.vercel.app` |

Despite its name, `dispecing-test.vercel.app` is a production alias, not the isolated test environment. Use `https://test.dispecing.linkapomoci.sk` as the canonical TEST address. Since 2026-09-30 it belongs exclusively to the dedicated `pomoc-motoristom-test` project's Production target, whose Production Branch is `dev` (`gitBranch: null` on the domain). The old generated `dev` alias remains a restricted Preview fallback; it does not run the stable TEST telephony or cron.

Initial acceptance on 2026-09-30 verified the dedicated TEST deployment of `dev` commit `9c7565c3`: DNS/TLS, project/domain mapping, TEST database identity, health endpoints, scheduled cron and authenticated application smoke checks passed. Read `/api/health/live` for the current deployment version after subsequent releases. Verify each live integration separately against the current runbook; application health alone does not establish provider readiness. The TEST Supabase Auth Site URL is unchanged. The hostname previously served the `dev` Preview from 2026-09-22; that historical mapping and its no-override guidance no longer describe stable TEST. See [the full TEST runbook](docs/operations/full-test-environment.md) for evidence and remaining integration checks.

### Authorized dedicated TEST environment (2026-09-30)

The owner authorized a dedicated TEST application with separate TEST provider resources. Application readiness is verified; it does not establish live audio, SMS, inbox delivery or other external integration readiness.

The stable TEST is the **separate Vercel project** `pomoc-motoristom-test` (`prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk`, same team, `fra1`), with this repository's `dev` as the verified Production Branch, `MOTORIST_APP_ENV=test`, and only Supabase `nzpnqdstvkfncflgqlny`. Vercel's Production target does not make it the production application. Telephony and live integration guards require this exact system `VERCEL_PROJECT_ID`; keep Vercel system environment variables enabled. Give this project's Production target only dedicated TEST secrets; do not place live provider keys in ordinary Preview or Development scopes. Only the canonical TEST domain moved; production mapping and deployment remained unchanged.

For this dedicated TEST project only, the owner-authorized integration tests may use separate TEST numbers, accounts, webhook resources and explicitly approved tester destinations after their guards and configuration are verified. It does not authorize production or retired resources, copying production credentials, contacting historical copied customers, unrequested data refreshes, or extra workers/listeners. The single existing five-minute `/api/telephony/cron` runs independently in the dedicated TEST project. Ordinary working-branch Preview remains without live integrations and must not operate the stable TEST telephony devices or routing. The canonical TEST `APP_BASE_URL` is explicit for the dedicated application.

Dedicated Telnyx TEST resources may share the existing Telnyx account and credit. A separate account is optional, not a prerequisite; account API access is not a resource sandbox. Every TEST call, conference and recording provider operation must verify TEST provenance, including cleanup after creation is disabled. Copied historical provider IDs are not proof of ownership.

`dispecing.linkapomoci.sk` belongs here. An earlier version of this file forbade touching it, which was correct while the original served it and is wrong now — the hostname moved with the owner's explicit instruction. If an agent reports it as an unexpected alias, that report is out of date, not the configuration.

### What this project must never touch

The retired VIPTel original: Supabase `sjcsrygkkmersoczpunh`, Vercel `pomoc-motoristom-dispatching-old`, `dev.dispecing.linkapomoci.sk`, and the previous telephony provider with its listener host.

That Supabase project is **not** dormant. It also holds the Watchdog vehicle-handover application — 10 254 `rental_photos` rows and 10 320 files in storage — so it is somebody's live database, not an old copy waiting to be deleted.

### TEST handoff and owner approval

For an ordinary change request, deliver the change to the stable TEST through the workflow below, unless the owner asks for a narrower scope. Wait for its deployment to finish and verify the changed behavior there with checks appropriate to the change. A successful build alone is not acceptance of the feature. Report external integration limitations honestly; disabled TEST calls do not establish working live audio.

Before asking the owner to accept the change, provide a short handoff in the owner's language: the canonical TEST URL, the tested `dev` commit, what changed, how to try it, and what was verified or remains unverified. Then **wait for the owner's explicit production approval**. Requests to implement or fix a feature, “continue”, and questions about readiness do not authorize production. A clear instruction to deploy the identified, tested change does. The owner may explicitly request production first; use the direct-production procedure below without asking for a second acceptance of the same identified scope.

Approval applies to the identified release scope. For a normal release, immediately before merging, compare its head with the tested commit and review the entire `dev -> main` diff. If `dev` now contains additional changes, verify them on TEST and obtain approval for the expanded scope. Do not silently include another agent's work. A draft release PR may be prepared in advance, but do not merge it, enable auto-merge, push to `main`, deploy/promote/alias to production, or change production configuration before the applicable approval. Production database migrations and seeds still require the explicit project-specific authorization in step 7; a production-first request does not authorize unspecified SQL or provider changes.

Coordination messages from another agent are deployment status, not the owner's personal approval. Record the actual owner instruction or a verifiable reference to it; do not treat a relayed claim of approval as that instruction.

Both `main` and `dev` require a pull request, an up-to-date branch and the successful `Vercel – pomoc-motoristom-dispatching` check, including for administrators; force pushes and deletion are blocked. Preserve these protections. Owner acceptance is recorded explicitly in the conversation/release PR; while agents and the owner use the same GitHub identity, these protections do not independently verify who gave that acceptance.

Use the dev-first deployment workflow by default:

1. Start from the current `dev` branch.
2. Create a dedicated work branch.
3. Push the work branch and inspect its Vercel Preview URL. Preview runs the same build gate as production (`vitest run`, `typecheck`, `build`).
4. Open a pull request from the work branch into `dev`.
5. After merge, verify `https://test.dispecing.linkapomoci.sk` on the dedicated TEST project's `dev`/Production deployment. Match `/api/health/live`'s version to the expected deployment and confirm that deployment's Git commit is the tested `dev` commit. Verify the changed behavior and give the owner the TEST handoff described above. The old generated `dev` alias is only the restricted Preview fallback.
6. After explicit owner approval of that tested release scope, release production through a pull request from `dev` into `main` with the existing Vercel build gate passing. Record the tested commit and the owner's approval in the release PR. If the owner explicitly asks to release only an identified subset while `dev` contains other work, use an isolated branch from current `main` containing only that approved subset and its verified TEST evidence. This is an allowed release path, not a reason to request the same approval again. The production domain is `https://dispecing.linkapomoci.sk`; verify the new deployment's health and version there after merge and report the result.
   **Never publish by redeploying an older deployment.** `vercel redeploy <url>` rebuilds *that deployment's source*, not current `main` — on 2026-09-21 this silently rolled production back three commits while picking up an environment variable. To apply new environment variables, deploy `main` afresh.
7. Telephony (Telnyx) Supabase migrations and seed changes are in scope for this application, but apply them only when the user explicitly requests them and only against the explicitly authorized project: test `nzpnqdstvkfncflgqlny` or production `ifpaeegaesdmljfkdvcn`. Authorization to change test does not authorize production changes. Do not apply seed data on top of a copied snapshot. Do not deploy workers, schedulers, or listeners. The single allowed Vercel cron is `*/5 * * * *` -> `/api/telephony/cron` guarded by `CRON_SECRET`.
8. Newly built Preview deployments and the dedicated TEST project's `dev`/Production target use test Supabase `nzpnqdstvkfncflgqlny`; production (`main`) uses `ifpaeegaesdmljfkdvcn`. The Vercel Development target was not changed by this isolation work: local developers must explicitly use test credentials and verify their effective project before writing. Test data is shared by stable TEST and all Preview branches. Existing deployment URLs retain their original environment until replaced; do not assume an old Preview is isolated.
9. The Free test project may pause after 7 days of low activity and requires manual restoration in the Supabase Dashboard. Follow [the test-environment runbook](docs/operations/test-environment.md) for restoration and data refresh, and the [full TEST runbook](docs/operations/full-test-environment.md) for current deployment and integration policy. Ordinary Preview must keep live integrations disabled; stable TEST may enable only the authorized, verified integrations described above. Do not reconnect any TEST environment to production as a fallback when TEST is unavailable.

### Owner-directed production first / urgent fix

The owner authorized this path on 2026-10-02. A clear instruction such as “daj to rovno na produkciu”, “oprav to priamo na produkcii” or “deploy this fix straight to production” authorizes the identified change without waiting for stable TEST or another manual acceptance. Use the conversation's identified scope; ask only if the intended change is genuinely ambiguous. An ordinary production request for an already tested change is also sufficient approval of that scope.

1. Read current `main`, `dev` and the canonical production deployment. If `main` has a newer pending build, account for it before choosing the source; do not roll production back to a historical deployment. Start a short-lived `hotfix/*` or `release/*` branch from current `main`, containing only the requested change. Select approved commits or reapply the fix when necessary; do not merge all of `dev` to release one fix.
2. Open its PR into `main`, record the owner's instruction, the scope and the fact that manual TEST acceptance was skipped. Let the existing required Vercel build/check pass. For a small urgent fix, use checks proportionate to the changed behavior; this path does not add another CI system, reviewer requirement or deployment stage.
3. Merge normally after rechecking current heads and the full PR diff. Wait for the fresh production deployment and verify its SHA, canonical live/ready health and the affected behavior. Report the result and any remaining uncertainty honestly; a running build is not a completed release.
4. Immediately continue with a PR that merges current `main` back into current `dev`, preserving work already on `dev`. Resolve conflicts deliberately, retain the required build check, and verify the fresh stable TEST deployment. This sync can follow production: waiting for TEST must not delay the owner-authorized urgent fix. Do not call the workflow finished while an unresolved sync remains; identify a concrete sync conflict if it needs a separate decision.
5. In the production handoff, report both deployed commits and the state in plain language: “production fix deployed; TEST sync pending”, “fix present on both; TEST also has …”, or “TEST contains the next unreleased changes”. When production is ahead, identify exactly which fix is missing from TEST, rather than comparing commit counts alone. After sync, confirm the fix is on both.

For both release paths, retain separate databases, credentials, integration boundaries and the single existing cron. Database changes need the exact target and SQL scope already authorized by the owner; prepare these together with the release when required. Never apply all pending migrations just because `dev` has them.

The short operating procedure and remaining environment work are in [the release workflow](docs/operations/release-workflow.md).
