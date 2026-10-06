/**
 * This standalone tracker shares the workspace's Turbopack resolution root.
 * Declare its own hook so Next never inherits dispatch instrumentation and its
 * application-specific aliases, telemetry configuration or integrations.
 */
export function register(): void {
  // The tracker has no server telemetry integration.
}
