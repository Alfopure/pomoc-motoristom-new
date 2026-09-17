import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

import { ownershipRpc } from "./ownership";
import { SessionLeaseLostError } from "./service-errors";

function admin(error: { code?: string; message: string } | null, data: unknown = null) {
  return { rpc: async () => ({ data, error }) } as unknown as SupabaseClient<Database>;
}

describe("ownershipRpc", () => {
  it("returns the payload of a successful call", async () => {
    await expect(ownershipRpc(admin(null, { generation: 3 }), "motorist_session_lease_acquire_v2", {})).resolves.toEqual({ generation: 3 });
  });

  it("turns an ownership refusal into a lost lease", async () => {
    for (const message of ["telephony ownership lost", "writer contract mismatch", "session lease expired"]) {
      await expect(ownershipRpc(admin({ code: "PT409", message }), "motorist_session_lease_renew_v2", {}))
        .rejects.toBeInstanceOf(SessionLeaseLostError);
    }
  });

  it("keeps the SQLSTATE on any other fenced refusal", async () => {
    // A termination committed elsewhere refuses new provider commands with
    // PT409. Callers have to tell that apart from an ordinary failure, and the
    // message alone is not something to match on.
    const refusal = { code: "PT409", message: "telephony termination blocks new provider command" };

    const error = await ownershipRpc(admin(refusal), "motorist_provider_command_prepare_v2", {}).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { code?: string }).code).toBe("PT409");
    expect((error as Error).message).toContain("telephony termination blocks new provider command");
    expect(error).not.toBeInstanceOf(SessionLeaseLostError);
  });

  it("leaves an ordinary failure without a code", async () => {
    const error = await ownershipRpc(admin({ message: "connection reset" }), "motorist_session_terminate_v2", {}).catch((value: unknown) => value);

    expect((error as Error & { code?: string }).code).toBeUndefined();
    expect((error as Error).message).toContain("connection reset");
  });
});
