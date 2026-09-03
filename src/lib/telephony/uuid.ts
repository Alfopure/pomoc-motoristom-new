/**
 * One UUID check for the route-segment ids the telephony endpoints take.
 *
 * Passing a raw path segment to PostgREST makes Postgres raise `22P01 invalid
 * input syntax for type uuid`, which the action layer can only report as a 500
 * with the database's own message in it. A malformed id is not a server
 * failure — it is a call, a leg or a request that does not exist — so it is
 * rejected here and answered with 404.
 *
 * Deliberately not version-constrained: the check exists to keep malformed
 * input out of a query, not to police how an id was generated.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
