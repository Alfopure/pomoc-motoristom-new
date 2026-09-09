// Vercel may promote the first Git deployment of a new project automatically.
// Keep this repository's main-only production rule enforced by the build itself.
if (
  process.env.VERCEL_ENV === "production" &&
  process.env.VERCEL_GIT_COMMIT_REF !== "main"
) {
  console.error(
    "Testovanie: production is released only from main. Use a Preview deployment for this branch.",
  );
  process.exit(1);
}
