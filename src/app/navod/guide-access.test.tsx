import { beforeEach, describe, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ getDefaultMotoristAuthState: io.auth }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/components/guide", () => ({ GuideHome: () => null, GuideArticle: () => null }));
vi.mock("@/components/auth/MotoristLogin", () => ({ MotoristLogin: () => null }));
vi.mock("./[slug]/public-login-guide", () => ({ LoginGuide: () => null }));
import { GuideArticle, GuideHome } from "@/components/guide";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { LoginGuide } from "./[slug]/public-login-guide";
import GuidePage from "./page";
import GuideChapterPage from "./[slug]/page";

beforeEach(() => io.auth.mockReset());
describe("guide page access", () => {
  it("requires sign-in for the full guide and retains the selected chapter", async () => {
    io.auth.mockResolvedValue({ authorized: false });
    expect((await GuidePage()).type).toBe(MotoristLogin);
    const result = await GuideChapterPage({ params: Promise.resolve({ slug: "plany-zvonenia" }) });
    expect(result.type).toBe(MotoristLogin);
    expect(result.props.returnTo).toBe("/navod/plany-zvonenia");
  });
  it("exposes only small account help before login and keeps signed-in readers in the guide", async () => {
    io.auth.mockResolvedValue({ authorized: false });
    expect((await GuideChapterPage({ params: Promise.resolve({ slug: "prihlasenie" }) })).type).toBe(LoginGuide);
    io.auth.mockResolvedValue({ authorized: true });
    expect((await GuideChapterPage({ params: Promise.resolve({ slug: "prihlasenie" }) })).type).toBe(GuideArticle);
    expect((await GuidePage()).type).toBe(GuideHome);
  });
  it("does not silently turn an unknown chapter into a different article", async () => {
    await expect(GuideChapterPage({ params: Promise.resolve({ slug: "neexistuje" }) })).rejects.toThrow("NOT_FOUND");
    expect(io.auth).not.toHaveBeenCalled();
  });
});
