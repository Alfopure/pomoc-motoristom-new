import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRole } from "@/domain/types";
import { MutationError } from "@/server/motorist-mutations";

const state = { role: "manager" as AppRole, authenticated: true };
const assertSameOriginRequest = vi.fn();
const getAnnouncementLines = vi.fn();
const saveLineAnnouncements = vi.fn();
const generateAnnouncementAudio = vi.fn();
const announcementGenerationAvailable = vi.fn(() => true);

vi.mock("@/server/api-auth", () => ({
  assertSameOriginRequest: (...args: unknown[]) => assertSameOriginRequest(...args),
  requireDefaultMotoristActor: async (roles: AppRole[]) => {
    if (!state.authenticated) throw new MutationError("Prihlás sa.", 401);
    if (!roles.includes(state.role)) throw new MutationError("Nemáš oprávnenie na túto akciu.", 403);
    return { userId: "user-1", profileId: "profile-1", organizationId: "org-1", displayName: "Manažér", role: state.role };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ marker: "admin" }) }));
vi.mock("@/server/telephony/announcements-service", () => ({
  getAnnouncementLines: (...args: unknown[]) => getAnnouncementLines(...args),
  saveLineAnnouncements: (...args: unknown[]) => saveLineAnnouncements(...args),
  generateAnnouncementAudio: (...args: unknown[]) => generateAnnouncementAudio(...args),
  announcementGenerationAvailable: () => announcementGenerationAvailable(),
}));

import { ConfigServiceError } from "@/server/telephony/config-service";
import { GET, PUT } from "./route";
import { POST } from "./generate/route";

const line = { id: "line-1", label: "Pomoc motoristom", phoneNumber: "+421232408700", config: {}, revision: "2026-09-06T10:00:00.000Z" };

function request(method: string, body: Record<string, unknown> = {}) {
  return new Request("https://app.test/api/telephony/config/announcements", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.role = "manager";
  state.authenticated = true;
  assertSameOriginRequest.mockReset();
  getAnnouncementLines.mockReset().mockResolvedValue([line]);
  saveLineAnnouncements.mockReset().mockResolvedValue(line);
  generateAnnouncementAudio.mockReset().mockResolvedValue({ audioUrl: "https://media.test/example.mp3", text: "Dobrý deň.", voiceId: "voice-1", language: "sk" });
  announcementGenerationAvailable.mockReset().mockReturnValue(true);
});

describe("announcement configuration routes", () => {
  it("returns only the announcement read model to a dispatcher and disables editing", async () => {
    state.role = "dispatcher";
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ lines: [line], canEdit: false, generationAvailable: true });
    expect(getAnnouncementLines).toHaveBeenCalledWith({ admin: { marker: "admin" } }, "org-1");
  });

  it("reports an unavailable generator without exposing server credentials", async () => {
    announcementGenerationAvailable.mockReturnValue(false);
    await expect((await GET()).json()).resolves.toMatchObject({ generationAvailable: false, canEdit: true });
  });

  it("requires authentication to read configuration", async () => {
    state.authenticated = false;
    expect((await GET()).status).toBe(401);
    expect(getAnnouncementLines).not.toHaveBeenCalled();
  });

  it.each(["dispatcher", "senior_dispatcher"] as AppRole[])("refuses saves and paid generations to %s", async (role) => {
    state.role = role;
    expect((await PUT(request("PUT"))).status).toBe(403);
    expect((await POST(request("POST"))).status).toBe(403);
    expect(saveLineAnnouncements).not.toHaveBeenCalled();
    expect(generateAnnouncementAudio).not.toHaveBeenCalled();
  });

  it.each(["manager", "admin"] as AppRole[])("allows %s to save but takes actor and organization from the session", async (role) => {
    state.role = role;
    const response = await PUT(request("PUT", { lineId: line.id, revision: line.revision, config: {}, organizationId: "foreign", actor: { profileId: "foreign" } }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(line);
    expect(saveLineAnnouncements).toHaveBeenCalledWith(expect.anything(), {
      lineId: line.id,
      revision: line.revision,
      config: {},
      organizationId: "org-1",
      actor: { profileId: "profile-1", role, displayName: "Manažér" },
    });
  });

  it("generates a preview under the session organization without saving the line", async () => {
    const response = await POST(request("POST", { lineId: line.id, key: "welcome", language: "sk", text: "Dobrý deň.", voiceId: "voice-1", organizationId: "foreign" }));
    expect(response.status).toBe(200);
    expect(generateAnnouncementAudio).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: "org-1", text: "Dobrý deň." }));
    expect(saveLineAnnouncements).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("checks same origin before authentication for both mutations", async () => {
    state.authenticated = false;
    assertSameOriginRequest.mockImplementation(() => { throw new MutationError("Požiadavka neprešla bezpečnostnou kontrolou.", 403); });
    expect((await PUT(request("PUT"))).status).toBe(403);
    expect((await POST(request("POST"))).status).toBe(403);
    expect(assertSameOriginRequest).toHaveBeenCalledTimes(2);
    expect(saveLineAnnouncements).not.toHaveBeenCalled();
    expect(generateAnnouncementAudio).not.toHaveBeenCalled();
  });

  it("returns an actionable conflict when another user changed the line", async () => {
    saveLineAnnouncements.mockRejectedValueOnce(new ConfigServiceError("Linku medzitým upravil kolega. Načítaj ju znova.", 409, "stale_document"));
    const response = await PUT(request("PUT", { lineId: line.id }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "stale_document" });
  });

  it("preserves safe provider errors and validation status", async () => {
    generateAnnouncementAudio.mockRejectedValueOnce(new ConfigServiceError("Generovanie zvuku nie je nastavené.", 503, "generation_unavailable"));
    const response = await POST(request("POST"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Generovanie zvuku nie je nastavené.", code: "generation_unavailable" });
  });
});
