<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Deployment rule

This repository is the separate Telnyx copy of the dispatch application. It has its own Supabase project (Frankfurt) and its own Vercel project (region `fra1`). It must never reference, read, or modify the original production project: Supabase `sjcsrygkkmersoczpunh`, Vercel `pomoc-motoristom-dispecing`, `dispecing.linkapomoci.sk`, or the previous telephony provider and its listener host.

Use the dev-first deployment workflow:

1. Start from the current `dev` branch.
2. Create a dedicated work branch.
3. Push the work branch and inspect its Vercel Preview URL. Preview runs the same build gate as production (`vitest run`, `typecheck`, `build`).
4. Open a pull request from the work branch into `dev`.
5. After merge, verify the `dev` branch alias of this Vercel project.
6. Release production only through a pull request from `dev` into `main`. The production domain of this copy is `https://test.dispecing.linkapomoci.sk` (until its CNAME exists, the project's `*.vercel.app` production alias serves the same deployment).
7. Telephony (Telnyx) Supabase migrations and seed changes are in scope for this copy, but apply them only when the user explicitly requests it and only against this copy's Supabase project. Do not deploy workers, schedulers, or listeners. The single allowed Vercel cron is `*/5 * * * *` -> `/api/telephony/cron` guarded by `CRON_SECRET`.
8. Development and Preview deployments use this copy's Supabase project, so every write is real for everyone testing on it.
