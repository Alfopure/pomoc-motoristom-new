/**
 * The error class every mutation and service layer throws, on its own so that
 * catching it costs nothing.
 *
 * It used to live in `motorist-mutations.ts`. Importing it from there pulls in
 * 4 000 lines of case, task and attendance mutations, the SW House integration
 * client and the e-mail transport — which is what the Telnyx webhook route was
 * doing on every cold start, for a five-line class it only ever uses in an
 * `instanceof` check. `motorist-mutations.ts` re-exports it, so every existing
 * importer keeps working; latency-sensitive paths import it from here.
 */
export class MutationError extends Error {
  constructor(message: string, readonly status = 500, readonly code?: string) {
    super(message);
  }
}
