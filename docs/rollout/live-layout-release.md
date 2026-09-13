# Live layout preview: release and return path

This preview changes the presentation of the existing authenticated application. It preserves the existing data loaders, components, inputs, filters, sorting, permission checks and mutations. It is a work-branch Preview, not a production release, database copy or replacement application.

## Checked baseline

Independent read-only preflight on 12 September 2026:

| Item | Evidence |
| --- | --- |
| Source | `origin/dev`, `6cbd23eb1769cfa99a5b694f2f5c4e2af1fe6b70` |
| Dedicated work branch | `feat/live-layout-preview` |
| Allowed Vercel project | `pomoc-motoristom-new`, `prj_DN3smSO1EbGowAmw3nHLQUYoSVJG` |
| Vercel team | `alfopures-projects`, `team_56GjBnBw6zGSG83LJAnQCB8T` |
| Runtime region | `fra1`, confirmed on the current dev deployment |
| Existing dev deployment | `dpl_79oiWqBH5rq9Lw1ZycbHjrxn7VmQ`, READY, source `git`, exact baseline SHA |
| Existing dev alias | <https://pomoc-motoristom-new-git-dev-alfopures-projects.vercel.app> |
| Data target | Existing Supabase project of this Telnyx copy, `ifpaeegaesdmljfkdvcn`; no new project or dataset |
| Existing build command | Vercel build log confirms `pnpm exec vitest run && pnpm run typecheck && pnpm run build` |

The dev baseline was checked without a user session: `GET /api/health/live` returned 200 and the expected deployment version; `GET /` returned 200 with application login and without Vercel SSO; `GET /auth/forgot-password` returned 200; an anonymous `GET /api/cases/00000000-0000-0000-0000-000000000000` returned 401. No form, mutation, sync, email, SMS or call was submitted.

The existing deployment is the baseline evidence, not evidence that the new work branch has been deployed. The release operator must record the new SHA and Preview URL after the new build reaches READY.

## Architecture review

The same-component-tree presentation toggle is preferable to a parallel rewritten console for this request. Keeping one `DispatchConsole` and its existing descendants preserves code paths for advanced filtering, list metadata, case editing, full-screen case modes, resizers, side-panel collapse and telephony. A separate demo implementation would need to reconstruct those behaviors and could silently omit them.

Required implementation boundaries:

- Change an appearance attribute/class and an isolated preference. Do not change React keys, duplicate the console, remount providers, navigate or reload when switching appearance. An unsaved case, SMS draft, current call, selected case, active filter and open widget must survive the toggle.
- Keep existing navigation, column-width and workspace preference keys and schemas. Store the appearance choice separately; changing appearance must not reset another preference. Recover from missing, malformed or denied browser storage.
- Scope presentation selectors to the new appearance. Keep the old presentation reachable immediately. Do not globally restyle dialogs or native controls unintentionally; test overlays that render in portals separately.
- Keep the full metadata in the left-hand case cards. Text wrapping and spacing may change; removing fields, filter controls, actions or data from the DOM is outside this visual layer.
- Preserve existing panel resize and collapse handlers and case split/expanded/collapsed modes. Test the layout with both side panels, each independently collapsed, tools opened, long values and tall dialogs, particularly at notebook dimensions.
- Any added calendar or calculator controls should extend the current widget host and its saved preferences rather than introduce an independent personal-tools model.
- Do not replace working task, SMS or other business workflows merely because the earlier illustrative mockup used simplified models. New reviewer workflow, external handoff authorization and other changes to persisted behavior need their own implementation contract and validation.

## Authentication and shared writes

The existing server page calls `getDefaultMotoristAuthState()` before `loadDispatchData()`. Normal application authorization uses Supabase `auth.getUser()` and an active organization profile; APIs keep their existing guards and same-origin mutation checks. The visual layer must not relax them.

This copy's [deployment runbook](../deployment-vercel.md) specifies that Vercel Preview Authentication is disabled to allow colleagues to reach the application login without a Vercel account. Application authentication stays required. It also specifies `MOTORIST_DEV_AUTH_BYPASS=false`, `TELNYX_LIVE_CALLS_ENABLED=false` and `TELNYX_SMS_LIVE_SENDS=false` for general Preview. The available read-only Vercel connector does not expose effective environment values; the preflight did not independently verify the latter two switches and must not claim otherwise. Anonymous HTTP behavior does independently confirm that the tested dev deployment requires application login.

Preview uses the same Supabase project as this copy's dev application. After normal sign-in, saving a case, task or note is a real shared write. An appearance toggle cannot roll back such a write. Returning to the old appearance returns the presentation only; it does not revert saved business data. State this succinctly in the preview interface and delivery note.

There is no existing general read-only application mode proven by this preflight. Do not invent a client-only read-only promise, expose a service role, enable auth bypass, seed data or create accounts for this task. No authenticated browser state or app test-user credentials were available locally during preflight. Local browser regression should use intercepted fixtures, while deployed smoke stays anonymous and non-mutating. The user can review the real dataset with their existing account and permissions.

## Release procedure

1. Keep the work branch based on the checked `dev` baseline. Review the final diff for removed functionality, changed mutation/auth paths, environment changes and unexpected dependencies.
2. Run local Vitest, typecheck and build; run targeted presentation regression with intercepted data. Cover switch-with-draft, filters, sorting, list details, both resizers/collapse controls, case height modes, tools, global and local tabs, mobile and notebook layouts. Do not point mutation tests at the shared Preview database.
3. Commit and push `feat/live-layout-preview`. The existing Vercel Git integration creates the durable branch Preview automatically; no manual `--prod` deployment, worker, listener or scheduler is needed.
4. Use only the allowed project. Verify the new deployment is READY, its source SHA and branch match, the runtime region is `fra1`, and the build log includes all three gates. Record the immutable deployment URL and branch alias. Do not guess a Vercel slug before it exists.
5. On the new Preview, repeat HTTPS health, login and safe forgot-password deep-link checks, plus an anonymous synthetic case GET. Verify the appearance query/deep link is reachable without bypassing app login. Do not submit forms or trigger calls, SMS, email, sync or scheduled work.
6. Open the work branch pull request into `dev`, keeping the preview available for the user's review. Do not merge merely to obtain a Preview URL. This task does not authorize a production release.
7. If the user later accepts the change, follow the repository's normal `work branch -> dev -> main` process; verify the dev alias after merge. Production remains a separate release PR from `dev` to `main`.

## Return path and acceptance record

The first return path is the in-app original/new appearance toggle on the same mounted tree. The second is returning to the unchanged existing dev deployment while the design remains in the work branch. The immutable Git baseline allows a precise code comparison. If an accepted change later needs reversal, revert its dedicated commit through a new work-branch PR into `dev`; do not reset shared branches, remove migrations or restore database snapshots for a visual change.

Record final verification separately from this preflight: source SHA, immutable URL and branch alias, READY status, build test counts, focused browser coverage, screenshots at notebook/mobile sizes, and any limits such as missing physical-device or authenticated real-data verification. A durable Vercel deployment removes dependence on the temporary tunnel/server that caused the previous visual demonstration links to stop working.
