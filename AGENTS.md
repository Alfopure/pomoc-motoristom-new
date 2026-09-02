<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Deployment rule

Use the dev-first deployment workflow:

1. Start from the current `dev` branch.
2. Create a dedicated work branch.
3. Push the work branch and inspect its Vercel Preview URL.
4. Open a pull request from the work branch into `dev`.
5. After merge, verify `https://dev.dispecing.linkapomoci.sk`.
6. Release production only through a pull request from `dev` into `main`.
7. Never include Supabase migrations, workers, schedulers, listeners, or Hetzner activation unless the user explicitly requests them.
8. Development and Preview deployments use production data, so all writes are real.
