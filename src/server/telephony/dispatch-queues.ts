/**
 * The dispatch queue identities, in priority order.
 *
 * Deliberately a leaf module with no imports of its own. `dispatch-routing`
 * sits deep in an import graph that reaches back through assignment-interlock
 * and fallback-settings, so anything needing only these constants must not pull
 * that whole graph in -- doing so creates an import cycle whose module-init
 * order is load-bearing and fails in non-obvious ways.
 */
export const DISPATCH_QUEUE_NUMBERS = ["601", "602", "603"] as const;

export type DispatchQueueNumber = (typeof DISPATCH_QUEUE_NUMBERS)[number];
