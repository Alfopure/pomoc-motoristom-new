import { expect, test, type Page, type Route } from "@playwright/test";

import type { WorkplaceTakeoverSnapshot } from "@/lib/telephony/workplace-takeover";

const workplaceExtensions = ["20", "21", "22", "23"] as const;

test.describe("dynamické pracovné miesta", () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), "Mutačné UI scenáre sa spúšťajú iba lokálne s úplne stubovaným API.");

  test("používateľ bez pracoviska stále vidí všeobecný stav ústredne", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page);

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);

    await expect(page.getByText("Voľní 0/0", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(
      "Vyber si pracovisko, keď chceš prijímať alebo uskutočňovať hovory. Všeobecný stav ústredne zostáva dostupný.",
      { exact: true },
    )).toBeVisible();
    await expect(page.getByText(/Tvoj stav sa teraz nedá bezpečne overiť/)).toHaveCount(0);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("nové okno bez obnovovacieho kľúča ponúkne jednu jasnú obnovu pracoviska", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      omitInitialResumeCredential: true,
    });

    await openWorkplace(page);

    await expect(page.getByText(
      "Predchádzajúce okno zostalo priradené k tomuto miestu. Obnov pracovisko a telefón sa bezpečne pripojí znova.",
      { exact: true },
    )).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/Obnovovací kľúč pracovného miesta/)).toHaveCount(0);
    const recover = page.getByRole("button", { name: "Obnoviť pracovisko", exact: true });
    await expect(recover).toBeEnabled();
    await recover.click();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "select_seat").length).toBe(1);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    await expect(recover).toHaveCount(0);
    await expect(page.getByText("Pripravený (test)", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  for (const [index, extensionNumber] of workplaceExtensions.entries()) {
    test(`pracovné miesto ${extensionNumber} sa dá rovnako obsadiť a telefón sa pripojí automaticky`, async ({ page }) => {
      const api = await installHotdeskApiFirewall(page);
      const consoleErrors = collectConsoleErrors(page);

      await page.setViewportSize({ width: 1280, height: 900 });
      await openWorkplace(page);
      const choose = page.getByRole("button", {
        name: `Vybrať pracovné miesto ${index + 1}, interná linka ${extensionNumber}`,
        exact: true,
      });
      await choose.focus();
      await page.keyboard.press("Enter");

      await expect(page.getByRole("dialog")).toHaveCount(0);

      await expect.poll(() => api.patchBodies.filter((body) => body.action === "select_seat").length).toBe(1);
      const select = api.patchBodies.find((body) => body.action === "select_seat");
      expect(select).toMatchObject({ action: "select_seat", extension: extensionNumber });
      expect(select?.browserInstanceId).toMatch(uuidPattern);
      expect(select?.idempotencyKey).toMatch(uuidPattern);
      expect(select).not.toHaveProperty("profileId");
      expect(select).not.toHaveProperty("organizationId");

      await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
      expect(api.webphoneSessionBodies[0]).toMatchObject({
        extension: extensionNumber,
        assignmentGeneration: expect.any(String),
        browserInstanceId: select?.browserInstanceId,
        leaseId: expect.any(String),
        leaderEpoch: expect.any(Number),
        leaseVersion: expect.any(Number),
      });
      await expect(page.getByText("Moje miesto", { exact: true })).toBeVisible();
      await expect.poll(() => api.patchBodies.filter((body) => body.action === "claim_priority").length).toBe(1);

      await page.setViewportSize({ width: 390, height: 844 });
      await expectNoDocumentOverflow(page, `pracovné miesto ${extensionNumber} na mobile`);

      expect(api.unexpectedRequests).toEqual([]);
      expect(consoleErrors).toEqual([]);
    });
  }

  test("nové pracovisko sa po potvrdení poradia automaticky nastaví na Dostupný", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { pausedExtensions: ["20"] });
    await openWorkplace(page);

    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 1, interná linka 20",
      exact: true,
    }).click();

    await expect.poll(() => api.queueAgentBodies.length).toBe(1);
    expect(api.queueAgentBodies[0]).toMatchObject({
      action: "available",
      extension: "20",
      assignmentGeneration: expect.any(String),
      browserInstanceId: expect.any(String),
      leaseId: expect.any(String),
      leaderEpoch: expect.any(Number),
      leaseVersion: expect.any(Number),
    });
    await expect(page.getByText("Pracovné miesto 20 je pripravené a tvoj stav je Dostupný.", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("potvrdený VIPTel krok prerušeného poradia sa pri výbere dokončí bez strašidelnej chyby", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { blockPriorityAfterClaimOnce: true });
    await openWorkplace(page);

    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 1, interná linka 20",
      exact: true,
    }).click();

    await expect.poll(() => api.patchBodies.map((body) => body.action)).toEqual([
      "select_seat",
      "claim_priority",
      "recover_priority",
    ]);
    await expect(page.getByText(/VIPTel krok je potvrdený, ale dokončenie poradia sa prerušilo/)).toHaveCount(0);
    await expect(page.getByText("Pracovné miesto 20 je pripravené a tvoj stav je Dostupný.", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("offline miesto obsadí bežný operátor bez administrátorského prevzatia", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { staleExtensions: ["21"] });
    await openWorkplace(page);

    const seat = page.locator('[data-workplace-station="21"]');
    await expect(seat.getByText("Offline · možno obsadiť", { exact: true })).toBeVisible();
    await expect(seat.getByText("Mango Mango je offline. Miesto môžeš bezpečne obsadiť.", { exact: true })).toBeVisible();
    await page.getByRole("button", {
      name: "Obsadiť pracovné miesto 2, interná linka 21, po offline operátorovi Mango Mango",
      exact: true,
    }).click();

    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    expect(api.patchBodies.map((body) => body.action)).toEqual(["select_seat"]);
    expect(api.patchBodies.some((body) => body.action === "takeover_seat")).toBe(false);
    await expect(seat.getByText("Moje miesto", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("online operátora požiada o odovzdanie bez tichého vyhodenia", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { activeExtensions: ["21"] });
    await openWorkplace(page);

    const requestButton = page.getByRole("button", {
      name: "Požiadať operátora Michal Aktívny o pracovné miesto 2, interná linka 21",
      exact: true,
    });
    await expect(requestButton).toBeEnabled();
    await requestButton.click();

    await expect.poll(() => api.takeoverBodies).toContainEqual({ action: "request", extension: "21" });
    await expect(page.locator('[data-workplace-station="21"]').getByText("Čaká na odpoveď", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Zrušiť moju žiadosť", exact: true }).click();
    await expect.poll(() => api.takeoverBodies.map((body) => body.action)).toEqual(["request", "cancel"]);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("odmietnutie zablokuje ďalšiu žiadosť o rovnaké miesto na päť minút", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      activeExtensions: ["21"],
      takeoverCooldownExtension: "21",
    });
    await openWorkplace(page);

    const seat = page.locator('[data-workplace-station="21"]');
    await expect(seat.getByText(/Žiadosť bola odmietnutá\. Ďalšiu môžeš poslať o 4:5\d\./)).toBeVisible();
    const blocked = seat.getByRole("button", { name: /bola odmietnutá; ďalšia žiadosť bude dostupná/ });
    await expect(blocked).toBeDisabled();
    expect(api.takeoverBodies).toEqual([]);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("majiteľ pracoviska môže žiadosť výslovne odmietnuť", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "21",
      incomingTakeoverRequest: true,
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 });

    const dialog = page.getByRole("alertdialog", { name: "Chceš zostať na tomto pracovisku?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Ak nič neurobíš.*odovzdá automaticky/)).toBeVisible();
    await dialog.getByRole("button", { name: "Nie, zostávam tu", exact: true }).click();

    await expect.poll(() => api.takeoverBodies).toContainEqual({
      action: "respond",
      decision: "decline",
      requestId: takeoverRequestId,
    });
    await expect(dialog).toHaveCount(0);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("schválenie žiadosti najprv bezpečne odpojí a uvoľní pracovisko", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "21",
      incomingTakeoverRequest: true,
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 });

    const dialog = page.getByRole("alertdialog", { name: "Chceš zostať na tomto pracovisku?" });
    await dialog.getByRole("button", { name: "Áno, odovzdať teraz", exact: true }).click();

    await expect.poll(() => api.takeoverBodies).toContainEqual({
      action: "respond",
      decision: "accept",
      requestId: takeoverRequestId,
    });
    await expect.poll(() => api.patchBodies.map((body) => body.action)).toContain("leave_seat");
    await expect.poll(() => api.patchBodies.map((body) => body.action)).toContain("confirm_seat_change");
    await expect(dialog).toHaveCount(0);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("neodmietnutá žiadosť po časovači automaticky bezpečne uvoľní pracovisko", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "21",
      incomingTakeoverRequest: true,
      timedOutTakeoverRequest: true,
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 });

    await expect.poll(() => api.patchBodies.map((body) => body.action)).toContain("leave_seat");
    await expect.poll(() => api.patchBodies.map((body) => body.action)).toContain("confirm_seat_change");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(api.takeoverBodies).toEqual([]);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("žiadateľ po uplynutí časovača skúsi prevzatie aj bez otvoreného okna pôvodného operátora", async ({ page }) => {
    test.setTimeout(45_000);
    const api = await installHotdeskApiFirewall(page, {
      activeExtensions: ["21"],
      outgoingAcceptedTakeoverExtension: "21",
    });

    await openWorkplace(page);

    await expect.poll(() => api.patchBodies.some((body) =>
      body.action === "select_seat" && body.extension === "21",
    )).toBe(true);
    await expect.poll(() => api.takeoverBodies.some((body) =>
      body.action === "complete" && body.requestId === takeoverRequestId,
    ), { timeout: 25_000 }).toBe(true);
    await expect(page.getByText(/30 sekúnd.*Bezpečné prevzatie už prebieha automaticky/)).toHaveCount(0);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("prvý klik sám dokončí úvodné overenie a obsadí miesto bez druhého kliknutia", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      providerRefreshChangesSeatVersion: true,
      staleExtensions: ["20"],
      storedPresenceDelayMs: 1_500,
    });
    await openWorkplace(page);

    await page.getByRole("button", {
      name: /Obsadiť pracovné miesto 1, interná linka 20/,
    }).click();

    await expect.poll(() => api.patchBodies.map((body) => `${body.action}:${body.extension ?? ""}`)).toEqual([
      "select_seat:20",
      "claim_priority:",
    ]);
    expect(api.patchBodies[0].expectedVersion).toBe("seat-20-v2");
    await expect(page.locator('[data-workplace-station="20"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    await expect(page.getByText("Najprv počkaj na bezpečné obnovenie predchádzajúcej relácie pracoviska.", { exact: true })).toHaveCount(0);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("vlastné expirované miesto v novom okne obnoví lease a telefón ešte pred poradím", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      expiredActorLease: true,
    });
    await openWorkplace(page);
    expect(api.webphoneSessionBodies).toEqual([]);
    expect(api.presenceBodies.filter((body) => body.action === "resume")).toEqual([]);

    await page.getByRole("button", {
      name: "Obnoviť pracovné miesto 1, interná linka 20",
      exact: true,
    }).click();

    await expect.poll(() => api.patchBodies.map((body) => body.action)).toEqual([
      "select_seat",
      "claim_priority",
    ]);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    const selectBody = api.patchBodies[0];
    const priorityBody = api.patchBodies[1];
    expect(selectBody).toMatchObject({ action: "select_seat", extension: "20" });
    expect(priorityBody).toMatchObject({
      action: "claim_priority",
      queue: "601",
      assignmentGeneration: api.webphoneSessionBodies[0].assignmentGeneration,
      browserInstanceId: selectBody.browserInstanceId,
      leaseId: api.webphoneSessionBodies[0].leaseId,
      leaderEpoch: api.webphoneSessionBodies[0].leaderEpoch,
      leaseVersion: api.webphoneSessionBodies[0].leaseVersion,
    });
    const selectIndex = api.events.indexOf("patch:select_seat:received");
    const webphoneIndex = api.events.indexOf("webphone:session", selectIndex + 1);
    const priorityIndex = api.events.indexOf("patch:claim_priority:received", webphoneIndex + 1);
    expect(webphoneIndex).toBeGreaterThan(selectIndex);
    expect(priorityIndex).toBeGreaterThan(webphoneIndex);
    await expect(page.locator('[data-workplace-station="20"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("vlastné expirované miesto so zlyhaným routing journalom najprv obnoví cez select_seat", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      expiredActorLease: true,
      priorityRecoveryBlocked: true,
      queueAssignments: { "601": "20" },
      recoverPriorityOnSeatSelect: true,
    });
    await openWorkplace(page);
    expect(api.webphoneSessionBodies).toEqual([]);
    expect(api.patchBodies).toEqual([]);

    await page.getByRole("button", {
      name: "Obnoviť pracovné miesto 1, interná linka 20",
      exact: true,
    }).click();

    await expect.poll(() => api.patchBodies.map((body) => body.action)).toEqual([
      "select_seat",
      "claim_priority",
    ]);
    expect(api.patchBodies.some((body) => body.action === "recover_priority")).toBe(false);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    const selectIndex = api.events.indexOf("patch:select_seat:received");
    const recoveryIndex = api.events.indexOf("server:routing_recovered:select_seat");
    const webphoneIndex = api.events.indexOf("webphone:session");
    const priorityIndex = api.events.indexOf("patch:claim_priority:received");
    expect(selectIndex).toBeGreaterThanOrEqual(0);
    expect(recoveryIndex).toBeGreaterThan(selectIndex);
    expect(webphoneIndex).toBeGreaterThan(recoveryIndex);
    expect(priorityIndex).toBeGreaterThan(webphoneIndex);
    await expect(page.getByText("Poradie zvonenia je aktívne.", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("zaseknuté vlastné poradie sa po pripojení telefónu obnoví automaticky s presným lease fence", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      priorityRecoveryBlocked: true,
      queueAssignments: { "601": "20" },
    });
    const consoleErrors = collectConsoleErrors(page);

    await openWorkplace(page);

    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    await expect.poll(() => api.patchBodies.filter((body) => body.action === "recover_priority").length).toBe(1);
    const recovery = api.patchBodies.find((body) => body.action === "recover_priority");
    expect(recovery).toMatchObject({
      action: "recover_priority",
      operationId: priorityRecoveryOperationId,
      assignmentGeneration: api.webphoneSessionBodies[0].assignmentGeneration,
      browserInstanceId: api.webphoneSessionBodies[0].browserInstanceId,
      leaseId: api.webphoneSessionBodies[0].leaseId,
      leaderEpoch: api.webphoneSessionBodies[0].leaderEpoch,
      leaseVersion: api.webphoneSessionBodies[0].leaseVersion,
    });
    expect(api.events.indexOf("patch:recover_priority:received"))
      .toBeGreaterThan(api.events.indexOf("webphone:session"));
    await expect(page.getByText("Poradie zvonenia je aktívne.", { exact: true })).toBeVisible();
    expect(api.queueAssignments()).toEqual({ "601": "20", "602": null, "603": null });
    expect(api.unexpectedRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("po dvoch automatických zlyhaniach zostane ručné Obnoviť poradie funkčné", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      priorityRecoveryBlocked: true,
      priorityRecoveryFailures: 2,
      queueAssignments: { "601": "20" },
    });
    await openWorkplace(page);

    await expect.poll(
      () => api.patchBodies.filter((body) => body.action === "recover_priority").length,
      { timeout: 10_000 },
    ).toBe(2);
    const manual = page.getByRole("button", { name: "Obnoviť poradie", exact: true });
    await expect(manual).toBeVisible();
    await manual.click();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "recover_priority").length).toBe(3);
    await expect(page.getByText("Poradie zvonenia je aktívne.", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("nový lease tej istej stoličky nespustí telefón ani heartbeat pod starým leaderom", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "21",
      expiredActorLease: true,
      retainedExpiredActorLease: true,
      webphoneSessionDelayMs: 750,
    });
    await openWorkplace(page);

    // Let the document become leader of the retained, already-expired lease.
    // The following same-seat claim must replace that exact lease id before it
    // is allowed to start either a heartbeat or a browser-phone session.
    await page.waitForTimeout(200);
    await page.getByRole("button", {
      name: "Obnoviť pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();

    await expect.poll(() => api.patchBodies.map((body) => body.action)).toEqual([
      "select_seat",
      "claim_priority",
    ]);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    // Wait beyond the deliberately slow session response so an abort/retry
    // from a transient old-leader render would be observable deterministically.
    await page.waitForTimeout(900);

    const heartbeatsAfterClaim = api.presenceBodies.filter((body) => body.action !== "resume");
    expect(api.webphoneSessionBodies).toHaveLength(1);
    expect(api.failedWebphoneSessionRequests).toEqual([]);
    expect(heartbeatsAfterClaim).toHaveLength(1);
    expect(api.webphoneSessionBodies[0].leaseId).not.toBe(api.initialLeaseId);
    expect(api.webphoneSessionBodies[0].leaseId).toBe(heartbeatsAfterClaim[0].leaseId);
    await expect(page.locator('[data-workplace-station="21"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("presun z expirovaného miesta 20 najprv obnoví zdroj v tomto okne a potom prejde na 21", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      expiredActorLease: true,
      queueAssignments: { "601": "20" },
    });
    await openWorkplace(page);

    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();

    await expect.poll(() => api.patchBodies.map((body) => `${body.action}:${body.extension ?? ""}`)).toEqual([
      "select_seat:20",
      "select_seat:21",
      "confirm_seat_change:",
    ]);
    expect(api.patchBodies[0].browserInstanceId).toBe(api.patchBodies[1].browserInstanceId);
    expect(api.patchBodies[0].idempotencyKey).not.toBe(api.patchBodies[1].idempotencyKey);
    await expect.poll(() => api.webphoneSessionBodies.some((body) => body.extension === "21")).toBe(true);
    await expect(page.locator('[data-workplace-station="21"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    await expect(page.locator('[data-workplace-station="20"]').getByText("Voľné", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("uvoľnenie expirovaného vlastného miesta najprv obnoví reláciu v tomto okne", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      expiredActorLease: true,
    });
    await openWorkplace(page);

    await page.getByRole("button", { name: "Uvoľniť pracovné miesto", exact: true }).click();

    await expect.poll(() => api.patchBodies.map((body) => body.action)).toEqual([
      "select_seat",
      "leave_seat",
      "confirm_seat_change",
    ]);
    await expect(page.getByText("Moje miesto", { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-workplace-station="20"]').getByText("Voľné", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("aktívneho operátora nemožno vytlačiť ani zmeniť dvojklikom", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { activeExtensions: ["22"] });
    await openWorkplace(page);

    const seat = page.locator('[data-workplace-station="22"]');
    await expect(seat.getByText("Aktívny operátor", { exact: true })).toBeVisible();
    await expect(seat.getByText(/je aktívny.*miesto nemožno prevziať/i)).toBeVisible();
    const blocked = page.getByRole("button", {
      name: "Pracovné miesto 3, interná linka 22, je obsadené",
      exact: true,
    });
    await expect(blocked).toBeDisabled();
    await blocked.dblclick({ force: true });
    expect(api.patchBodies).toEqual([]);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("presun 20 na 21 je dvojfázový a prenesie rovnaké poradie na nové miesto", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { actorExtension: "20", queueAssignments: { "601": "20" } });
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);

    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).dblclick();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "confirm_seat_change").length).toBe(1);
    expect(api.patchBodies.map((body) => body.action)).toEqual(["select_seat", "confirm_seat_change"]);
    expect(api.patchBodies[1]).toMatchObject({
      action: "confirm_seat_change",
      operationId: expect.any(String),
      idempotencyKey: api.patchBodies[0].idempotencyKey,
      browserInstanceId: api.patchBodies[0].browserInstanceId,
    });
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(2);
    await expect(page.locator('[data-workplace-station="21"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    await expect(page.locator('[data-workplace-station="20"]').getByText("Voľné", { exact: true })).toBeVisible();
    await expect.poll(() => api.queueAssignments()).toEqual({ "601": "21", "602": null, "603": null });
    expect(api.patchBodies.some((body) => body.action === "release_priority")).toBe(false);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("počas oneskoreného VIPTel odregistrovania znovu nepripojí pôvodné pracovné miesto", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      confirmDelayMs: 2_000,
      queueAssignments: { "601": "20" },
    });
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.map((body) => body.extension)).toEqual(["20"]);

    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "confirm_seat_change").length).toBe(1);
    await page.waitForTimeout(400);
    expect(api.webphoneSessionBodies.map((body) => body.extension)).toEqual(["20"]);

    await expect.poll(
      () => api.webphoneSessionBodies.map((body) => body.extension),
      { timeout: 10_000 },
    ).toEqual(["20", "21"]);
    expect(api.patchBodies.map((body) => body.action)).toEqual(["select_seat", "confirm_seat_change"]);
    await expect(page.locator('[data-workplace-station="20"]').getByText("Voľné", { exact: true })).toBeVisible();
    await expect(page.locator('[data-workplace-station="21"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("dočasne nepotvrdené odregistrovanie zopakuje presný presun bez cancelu a reconnectu zdroja", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      confirmUnregisterPendingOnce: true,
    });
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.map((body) => body.extension)).toEqual(["20"]);

    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "confirm_seat_change").length).toBe(2);
    const confirms = api.patchBodies.filter((body) => body.action === "confirm_seat_change");
    expect(confirms[1]).toEqual(confirms[0]);
    expect(new Set(confirms.map((body) => body.idempotencyKey))).toHaveProperty("size", 1);
    expect(new Set(confirms.map((body) => body.operationId))).toHaveProperty("size", 1);
    expect(api.patchBodies.map((body) => body.action)).toEqual([
      "select_seat",
      "confirm_seat_change",
      "confirm_seat_change",
    ]);
    expect(api.patchBodies.some((body) => body.action === "cancel_seat_change")).toBe(false);

    await expect.poll(
      () => api.webphoneSessionBodies.map((body) => body.extension),
      { timeout: 10_000 },
    ).toEqual(["20", "21"]);
    expect(api.webphoneSessionBodies.filter((body) => body.extension === "20")).toHaveLength(1);

    const pendingIndex = api.events.indexOf("patch:confirm_seat_change:unregister_pending");
    const secondConfirmIndex = api.events.indexOf("patch:confirm_seat_change:received", pendingIndex + 1);
    const successfulConfirmIndex = api.events.indexOf("patch:confirm_seat_change:responded", secondConfirmIndex + 1);
    const targetSessionIndex = api.events.indexOf("webphone:session", successfulConfirmIndex + 1);
    expect(pendingIndex).toBeGreaterThan(-1);
    expect(secondConfirmIndex).toBeGreaterThan(pendingIndex);
    expect(successfulConfirmIndex).toBeGreaterThan(secondConfirmIndex);
    expect(targetSessionIndex).toBeGreaterThan(successfulConfirmIndex);
    expect(api.events.slice(pendingIndex, successfulConfirmIndex)).not.toContain("webphone:session");

    const target = page.locator('[data-workplace-station="21"]');
    await expect(target.getByText("Moje miesto", { exact: true })).toBeVisible();
    await expect(page.getByText("Pripravený (test)", { exact: true })).toBeVisible();
    await expect(page.getByText(
      "Odchádzajúce telefonovanie z pracovného miesta 21 je pripojené.",
      { exact: true },
    )).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("operátor môže vlastné miesto opustiť bez zmeny poradia stoličky", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { actorExtension: "20", queueAssignments: { "601": "20" } });
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);

    await page.getByRole("button", { name: "Uvoľniť pracovné miesto", exact: true }).click();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "confirm_seat_change").length).toBe(1);
    expect(api.patchBodies.map((body) => body.action)).toEqual(["leave_seat", "confirm_seat_change"]);
    await expect(page.locator('[data-workplace-station="20"]').getByText("Voľné", { exact: true })).toBeVisible();
    await expect(page.getByText("Moje miesto", { exact: true })).toHaveCount(0);
    await expect.poll(() => {
      const finalizedAt = api.events.lastIndexOf("patch:confirm_seat_change:responded");
      const providerSynchronizedAt = api.events.indexOf("telephony-presence:provider", finalizedAt + 1);
      const canonicalWorkplaceReadAt = api.events.indexOf("selection:get", providerSynchronizedAt + 1);
      const webphoneConfigReadAt = api.events.indexOf("webphone:config", canonicalWorkplaceReadAt + 1);
      return finalizedAt >= 0 && providerSynchronizedAt > finalizedAt &&
        canonicalWorkplaceReadAt > providerSynchronizedAt && webphoneConfigReadAt > canonicalWorkplaceReadAt;
    }).toBe(true);
    expect(api.queueAssignments()).toEqual({ "601": "20", "602": null, "603": null });
    expect(api.patchBodies.some((body) => body.action === "release_priority")).toBe(false);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("zlyhané obnovenie po uvoľnení nezruší potvrdený odchod ani neklame o výsledku", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      failPostReleaseProviderRefresh: true,
    });
    await openWorkplace(page);

    await page.getByRole("button", { name: "Uvoľniť pracovné miesto", exact: true }).click();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "confirm_seat_change").length).toBe(1);
    const committedWarning = page.getByRole("status").filter({
      hasText: /Pracovné miesto je uvoľnené.*Aktuálny stav sa nepodarilo obnoviť.*Obnoviť stav/,
    });
    await expect(committedWarning).toBeVisible();
    await expect(committedWarning).toHaveClass(/bg-amber-50/);
    expect(api.patchBodies.some((body) => body.action === "cancel_seat_change")).toBe(false);
    expect(api.events).toContain("telephony-presence:provider:failed");
    await expect(page.getByText("Moje miesto", { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-workplace-station="20"]').getByText("Stav neznámy", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("stará karta po lease_lost odpojí telefón, no používateľ zostane v aplikácii", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { actorExtension: "20" });
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    await expect(page.getByText("Moje miesto", { exact: true })).toBeVisible();

    api.loseLeaseOnNextHeartbeat();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

    await expect.poll(() => api.leaseLostResponses).toBe(1);
    await expect(page.getByText("Moje miesto", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Linka pomoci motoristom", { exact: true })).toBeVisible();
    expect(api.webphoneSessionBodies).toHaveLength(1);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("dvojklik na obsadenie vytvorí iba jednu lease a jednu SIP session", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { selectDelayMs: 250 });
    await openWorkplace(page);
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 4, interná linka 23",
      exact: true,
    }).dblclick();

    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    expect(api.patchBodies.filter((body) => body.action === "select_seat")).toHaveLength(1);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("odchádzajúci príkaz z Prehľadu hovorov nesie aktuálny lease fence", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { actorExtension: "20" });
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);

    await page.getByRole("tab", { name: "Prehľad hovorov", exact: true }).click();
    await page.getByRole("button", { name: "Cez linku", exact: true }).click();
    await page.getByRole("textbox", { name: "Číslo", exact: true }).fill("+421910123456");
    await page.getByRole("button", { name: "Volať z linky", exact: true }).click();

    await expect.poll(() => api.callCreateBodies.length).toBe(1);
    expect(api.callCreateBodies[0]).toMatchObject({
      mode: "extension_callback",
      fromExtension: "20",
      toNumber: "+421910123456",
      assignmentGeneration: api.webphoneSessionBodies[0].assignmentGeneration,
      browserInstanceId: api.webphoneSessionBodies[0].browserInstanceId,
      leaseId: api.webphoneSessionBodies[0].leaseId,
      leaderEpoch: api.webphoneSessionBodies[0].leaderEpoch,
      leaseVersion: api.webphoneSessionBodies[0].leaseVersion,
    });
    await expect(page.getByText("VIPTel potvrdil hovor z pracovného miesta 20.", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("zlyhané potvrdenie presunu zruší prechod a obnoví pôvodné miesto", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      confirmChangeFails: true,
    });
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);

    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();

    await expect.poll(() => api.patchBodies.map((body) => body.action)).toEqual([
      "select_seat",
      "confirm_seat_change",
      "cancel_seat_change",
    ]);
    expect(api.patchBodies[2]).toMatchObject({
      browserInstanceId: api.patchBodies[0].browserInstanceId,
      idempotencyKey: api.patchBodies[0].idempotencyKey,
      operationId: api.patchBodies[1].operationId,
    });
    await expect(page.getByText("Simulované zlyhanie potvrdenia presunu.", { exact: true })).toBeVisible();
    await expect(page.locator('[data-workplace-station="20"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    await expect(page.locator('[data-workplace-station="21"]').getByText("Voľné", { exact: true })).toBeVisible();
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(2);
    expect(api.webphoneSessionBodies[1]).toMatchObject({ extension: "20", leaseVersion: 2 });
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("zlyhané začatie presunu ponechá pôvodný telefón pripojený bez zbytočnej novej session", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { actorExtension: "20" });
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.map((body) => body.extension)).toEqual(["20"]);
    api.makeNextSelectConflictWithoutCode();

    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();

    await expect(page.getByText("Pracovné miesto medzitým zmenila iná požiadavka.", { exact: true })).toBeVisible();
    await expect.poll(
      () => api.webphoneSessionBodies.map((body) => body.extension),
      { timeout: 10_000 },
    ).toEqual(["20"]);
    await expect(page.locator('[data-workplace-station="20"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    await expect(page.locator('[data-workplace-station="21"]').getByText("Voľné", { exact: true })).toBeVisible();
    expect(api.patchBodies.map((body) => body.action)).toEqual(["select_seat"]);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("opakované stratené odpovede pri presune zachovajú zdrojový telefón až do bezpečného recovery", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      // Klient má tri pokusy v jednom behu. Všetky musia zlyhať, aby vznikol
      // reálny continuity journal a tlačidlo Obnoviť dostupnosť.
      selectTransportFailures: 3,
    });
    const consoleErrors = collectConsoleErrors(page);
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.map((body) => body.extension)).toEqual(["20"]);
    await expect(page.getByText("Pripravený (test)", { exact: true })).toBeVisible();

    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "select_seat").length).toBe(3);
    const lostSelectAttempts = api.patchBodies.filter((body) => body.action === "select_seat");
    expect(lostSelectAttempts[1]).toEqual(lostSelectAttempts[0]);
    expect(lostSelectAttempts[2]).toEqual(lostSelectAttempts[0]);
    await expect(page.getByText(
      "Odpoveď servera sa stratila. Presná požiadavka je bezpečne uložená; obnov stránku a dokončenie sa skontroluje bez novej zmeny.",
      { exact: true },
    )).toBeVisible();

    // Kým serverový prepare nemá potvrdený výsledok, pôvodný telefón musí
    // zostať živý. Počas recovery je voľba webphone zámerne skrytá, preto
    // kontrolujeme stav hooku v hlavičke pracovného miesta; slabé automatické
    // disconnect() by tento stav preplo z `telefón pripojený` do idle.
    const callDetail = page.getByRole("complementary", { name: "Detail a ovládanie hovoru" });
    await expect(callDetail.getByText("telefón pripojený", { exact: true })).toBeVisible();
    await expect(callDetail.getByText(
      "Odchádzajúce telefonovanie z pracovného miesta 20 je pripojené.",
      { exact: true },
    )).toBeVisible();
    expect(api.webphoneSessionBodies.map((body) => body.extension)).toEqual(["20"]);
    expect(api.patchBodies.filter((body) => body.action === "confirm_seat_change")).toEqual([]);
    await callDetail.getByRole("textbox", { name: "Číslo", exact: true }).fill("+421910000000");
    await expect(callDetail.getByRole("button", { name: /^Volať/ })).toBeDisabled();

    await page.getByRole("button", { name: "Obnoviť dostupnosť", exact: true }).click();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "select_seat").length).toBe(4);
    const recoveredSelect = api.patchBodies.filter((body) => body.action === "select_seat");
    expect(recoveredSelect[3]).toEqual(recoveredSelect[0]);
    await expect.poll(() => api.patchBodies.filter((body) => body.action === "confirm_seat_change").length).toBe(1);
    await expect.poll(() => api.webphoneSessionBodies.map((body) => body.extension)).toEqual(["20", "21"]);
    await expect(page.locator('[data-workplace-station="21"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    await expect(page.locator('[data-workplace-station="20"]').getByText("Voľné", { exact: true })).toBeVisible();
    await expect(page.getByText(
      "Odpoveď servera sa stratila. Presná požiadavka je bezpečne uložená; obnov stránku a dokončenie sa skontroluje bez novej zmeny.",
      { exact: true },
    )).toHaveCount(0);
    expect(api.unexpectedRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("stratené odpovede sa bez kliknutia automaticky dokončia tou istou požiadavkou", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      // Prvý používateľský beh aj prvý automatický recovery beh vyčerpajú
      // všetky tri lokálne pokusy. Ďalší backoff cyklus musí sám uspieť.
      selectTransportFailures: 6,
    });
    const consoleErrors = collectConsoleErrors(page);
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.map((body) => body.extension)).toEqual(["20"]);

    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();

    await expect(page.getByText(
      "Odpoveď servera sa stratila. Presná požiadavka je bezpečne uložená; obnov stránku a dokončenie sa skontroluje bez novej zmeny.",
      { exact: true },
    )).toBeVisible();

    await expect.poll(
      () => api.patchBodies.filter((body) => body.action === "select_seat").length,
      { timeout: 15_000 },
    ).toBe(7);
    const recoveredSelect = api.patchBodies.filter((body) => body.action === "select_seat");
    expect(recoveredSelect.every((body) => JSON.stringify(body) === JSON.stringify(recoveredSelect[0]))).toBe(true);
    await expect.poll(() => api.patchBodies.filter((body) => body.action === "confirm_seat_change").length).toBe(1);
    await expect.poll(() => api.webphoneSessionBodies.map((body) => body.extension)).toEqual(["20", "21"]);
    await expect(page.locator('[data-workplace-station="21"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    await expect(page.locator('[data-workplace-station="20"]').getByText("Voľné", { exact: true })).toBeVisible();
    await expect(page.getByText(
      "Odpoveď servera sa stratila. Presná požiadavka je bezpečne uložená; obnov stránku a dokončenie sa skontroluje bez novej zmeny.",
      { exact: true },
    )).toHaveCount(0);
    expect(api.unexpectedRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("obsadené poradie sa pracovníkovi neponúka na ručné prehadzovanie", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      activeExtensions: ["21"],
      queueAssignments: { "601": "20", "602": "21" },
    });
    await openWorkplace(page);

    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(api.patchBodies).toEqual([]);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("voľné pracovisko zostáva dostupné bez ručného výberu poradia", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      queueAssignments: { "601": "20", "602": "21" },
    });
    await openWorkplace(page);

    await expect(page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    })).toBeEnabled();
    await expect(page.getByRole("radio")).toHaveCount(0);
    expect(api.patchBodies).toEqual([]);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("obnovenie stránky posiela resume s idempotency kľúčom nového dokumentu", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { actorExtension: "20" });
    await openWorkplace(page);
    await expect.poll(() => api.presenceBodies.length).toBeGreaterThan(0);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 });
    await expect.poll(() => api.presenceBodies.some((body) => body.action === "resume")).toBe(true);

    const resume = api.presenceBodies.find((body) => body.action === "resume");
    expect(resume).toMatchObject({
      action: "resume",
      browserInstanceId: expect.any(String),
      idempotencyKey: expect.any(String),
      leaseId: expect.any(String),
      resumeSecret: expect.any(String),
    });
    expect(resume?.idempotencyKey).toBe(resume?.browserInstanceId);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("stratená odpoveď prvého obsadenia zopakuje presne tú istú požiadavku", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { dropSelectResponseOnce: true });
    await openWorkplace(page);
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 4, interná linka 23",
      exact: true,
    }).click();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "select_seat").length).toBe(2);
    const selectRequests = api.patchBodies.filter((body) => body.action === "select_seat");
    expect(selectRequests[1]).toEqual(selectRequests[0]);
    expect(api.droppedPatchBodies).toEqual([selectRequests[0]]);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    await expect(page.locator('[data-workplace-station="23"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("potvrdená lease sa dokončí aj keď odpoveď neobsahuje odvodený snapshot", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { omitWorkplaceOnCommittedSelect: true });
    await openWorkplace(page);
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 3, interná linka 22",
      exact: true,
    }).click();

    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    await expect(page.locator('[data-workplace-station="22"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    expect(api.patchBodies.filter((body) => body.action === "select_seat")).toHaveLength(1);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("stratená odpoveď finálneho presunu sa idempotentne zopakuje bez druhej zmeny", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      dropConfirmResponseOnce: true,
    });
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "confirm_seat_change").length).toBe(2);
    const confirms = api.patchBodies.filter((body) => body.action === "confirm_seat_change");
    expect(confirms[1]).toEqual(confirms[0]);
    expect(new Set(confirms.map((body) => body.idempotencyKey))).toHaveProperty("size", 1);
    await expect.poll(() => api.webphoneSessionBodies.some((body) => body.extension === "21")).toBe(true);
    const targetSessions = api.webphoneSessionBodies.filter((body) => body.extension === "21");
    expect(new Set(targetSessions.map((body) => JSON.stringify({
      assignmentGeneration: body.assignmentGeneration,
      browserInstanceId: body.browserInstanceId,
      leaseId: body.leaseId,
      leaderEpoch: body.leaderEpoch,
      leaseVersion: body.leaseVersion,
    })))).toHaveProperty("size", 1);
    await expect(page.locator('[data-workplace-station="21"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("reload po stratenej finálnej odpovedi obnoví presnú zmenu skôr než spustí telefón", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      dropConfirmResponseOnce: true,
    });
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    const eventStart = api.events.length;
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();
    await expect.poll(
      () => api.droppedPatchBodies.filter((body) => body.action === "confirm_seat_change").length,
      { intervals: [10, 10, 20], timeout: 2_000 },
    ).toBe(1);
    expect(api.patchBodies.filter((body) => body.action === "confirm_seat_change")).toHaveLength(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 });
    await expect.poll(() => api.patchBodies.filter((body) => body.action === "confirm_seat_change").length).toBe(2);
    await expect.poll(() => api.webphoneSessionBodies.some((body) => body.extension === "21")).toBe(true);

    const confirms = api.patchBodies.filter((body) => body.action === "confirm_seat_change");
    expect(confirms[1]).toEqual(confirms[0]);
    const recoveryEvents = api.events.slice(eventStart);
    const lostIndex = recoveryEvents.indexOf("patch:confirm_seat_change:committed_response_lost");
    const snapshotIndex = recoveryEvents.indexOf("selection:get", lostIndex + 1);
    const replayIndex = recoveryEvents.indexOf("patch:confirm_seat_change:replayed", snapshotIndex + 1);
    const resumeIndex = recoveryEvents.indexOf("presence:resume:received", replayIndex + 1);
    const webphoneIndex = recoveryEvents.indexOf("webphone:session", resumeIndex + 1);
    expect(snapshotIndex).toBeGreaterThan(lostIndex);
    expect(replayIndex).toBeGreaterThan(snapshotIndex);
    expect(resumeIndex).toBeGreaterThan(replayIndex);
    expect(webphoneIndex).toBeGreaterThan(resumeIndex);
    expect(recoveryEvents.slice(snapshotIndex, resumeIndex)).not.toContain("presence:heartbeat:received");
    expect(api.webphoneSessionBodies.at(-1)?.browserInstanceId).not.toBe(confirms[0].browserInstanceId);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("odmietnuté sessionStorage nezmení potvrdené obsadenie na chybu v aktuálnom okne", async ({ page }) => {
    await page.addInitScript(() => {
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key: string, value: string) {
        if (key.startsWith("motorist.workplace.resume.v1")) {
          throw new DOMException("Storage denied by QA", "SecurityError");
        }
        return originalSetItem.call(this, key, value);
      };
    });
    const api = await installHotdeskApiFirewall(page);
    const consoleErrors = collectConsoleErrors(page);
    await openWorkplace(page);
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();

    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    await expect(page.locator('[data-workplace-station="21"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    await expect(page.getByText("Pripravený (test)", { exact: true })).toBeVisible();
    await expect(page.getByText("Si dostupný a môžeš prijímať hovory z radu.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Obnoviť pracovisko", exact: true })).toHaveCount(0);
    await expect(page.getByText(/Obnovovací kľúč pracovného miesta/)).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("vypnutý claim je terminálny a po zapnutí sa nespustí bez nového kliknutia", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { claimsDisabled: true });
    await openWorkplace(page);
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();

    await expect(page.getByText("Nové obsadenie pracoviska je dočasne pozastavené.", { exact: true })).toBeVisible();
    expect(api.patchBodies.filter((body) => body.action === "select_seat")).toHaveLength(1);
    const rejectedIdempotencyKey = api.patchBodies[0].idempotencyKey;
    api.enableClaims();
    await page.waitForTimeout(900);
    expect(api.patchBodies.filter((body) => body.action === "select_seat")).toHaveLength(1);
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    }).click();

    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    const selectRequests = api.patchBodies.filter((body) => body.action === "select_seat");
    expect(selectRequests).toHaveLength(2);
    expect(selectRequests[1].idempotencyKey).not.toBe(rejectedIdempotencyKey);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("bezpečne zrušený precommit je terminálny a nevytvára slučku exact retry", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, { precommitAborted: true });
    await openWorkplace(page);
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 3, interná linka 22",
      exact: true,
    }).click();

    await expect(page.getByText("Predchádzajúca zmena bola bezpečne zrušená. Vytvor novú požiadavku.", { exact: true })).toBeVisible();
    await page.waitForTimeout(900);
    expect(api.patchBodies.filter((body) => body.action === "select_seat")).toHaveLength(1);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("motorist.workplace.pending-mutation.v1"))).toBeNull();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("Obnoviť dostupnosť aktívne zopakuje uloženú požiadavku a odstráni terminálny lease_lost journal", async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem("motorist.workplace.pending-mutation.v1", JSON.stringify({
        action: "select_seat",
        actorProfileId: "op-natalia",
        attempts: 0,
        browserInstanceId: "11111111-1111-4111-8111-111111111111",
        createdAt: Date.now(),
        expectedVersion: "seat-21-v1",
        extension: "21",
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        kind: "select",
        phase: "prepare",
      }));
    });
    const api = await installHotdeskApiFirewall(page, { selectTransportFailures: 3 });
    await openWorkplace(page);

    const refresh = page.getByRole("button", { name: "Obnoviť dostupnosť", exact: true });
    await expect(refresh).toBeVisible();
    await expect.poll(() => api.patchBodies.filter((body) => body.action === "select_seat").length).toBe(3);
    api.makeNextSelectLeaseLost();
    await refresh.click();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "select_seat").length).toBe(4);
    const attempts = api.patchBodies.filter((body) => body.action === "select_seat");
    expect(attempts.every((body) => body.idempotencyKey === "22222222-2222-4222-8222-222222222222")).toBe(true);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("motorist.workplace.pending-mutation.v1"))).toBeNull();
    await expect(refresh).toHaveCount(0);
    await expect(page.getByRole("button", {
      name: "Vybrať pracovné miesto 1, interná linka 20",
      exact: true,
    })).toBeEnabled();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("čitateľný konflikt bez serverového kódu nezostane uložený a neuzamkne pracoviská", async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem("motorist.workplace.pending-mutation.v1", JSON.stringify({
        action: "select_seat",
        actorProfileId: "op-natalia",
        attempts: 0,
        browserInstanceId: "33333333-3333-4333-8333-333333333333",
        createdAt: Date.now(),
        expectedVersion: "seat-21-v1",
        extension: "21",
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
        kind: "select",
        phase: "prepare",
      }));
    });
    const api = await installHotdeskApiFirewall(page, { selectTransportFailures: 3 });
    await openWorkplace(page);

    const refresh = page.getByRole("button", { name: "Obnoviť dostupnosť", exact: true });
    await expect(refresh).toBeVisible();
    await expect.poll(() => api.patchBodies.filter((body) => body.action === "select_seat").length).toBe(3);
    api.makeNextSelectConflictWithoutCode();
    await refresh.click();

    await expect.poll(() => api.patchBodies.filter((body) => body.action === "select_seat").length).toBe(4);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("motorist.workplace.pending-mutation.v1"))).toBeNull();
    await expect(refresh).toHaveCount(0);
    await expect(page.getByRole("button", {
      name: "Vybrať pracovné miesto 1, interná linka 20",
      exact: true,
    })).toBeEnabled();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("rozpracované požiadavky iného používateľa sa po prihlásení neprehrajú", async ({ page }) => {
    await page.addInitScript(() => {
      const leaseId = "77777777-7777-4777-8777-777777777777";
      sessionStorage.setItem("motorist.workplace.pending-mutation.v1", JSON.stringify({
        action: "select_seat",
        actorProfileId: "operator-a",
        attempts: 1,
        browserInstanceId: "11111111-1111-4111-8111-111111111111",
        createdAt: Date.now(),
        expectedVersion: "seat-21-v1",
        extension: "21",
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        kind: "select",
        phase: "prepare",
      }));
      sessionStorage.setItem("motorist.workplace.pending-resume.v1", JSON.stringify({
        actorProfileId: "operator-a",
        assignmentGeneration: "33333333-3333-4333-8333-333333333333",
        attempts: 1,
        browserInstanceId: "44444444-4444-4444-8444-444444444444",
        createdAt: Date.now(),
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
        leaderEpoch: 1,
        leaseId,
        leaseVersion: 1,
        resumeSecret: "resume_secret_belonging_to_operator_a_123456789",
      }));
      sessionStorage.setItem(`motorist.workplace.resume.v1:${leaseId}`, JSON.stringify({
        browserInstanceId: "44444444-4444-4444-8444-444444444444",
        leaseId,
        resumeSecret: "resume_secret_belonging_to_operator_a_123456789",
      }));
    });
    const api = await installHotdeskApiFirewall(page, { actorProfileId: "operator-b" });
    await openWorkplace(page);

    await expect(page.getByText("Uložená rozpracovaná zmena patrila inému prihlásenému používateľovi, preto sa nespustila.", { exact: true })).toBeVisible();
    expect(api.patchBodies).toEqual([]);
    expect(api.presenceBodies.filter((body) => body.action === "resume")).toEqual([]);
    await expect.poll(() => page.evaluate(() => ({
      mutation: sessionStorage.getItem("motorist.workplace.pending-mutation.v1"),
      resume: sessionStorage.getItem("motorist.workplace.pending-resume.v1"),
      credential: sessionStorage.getItem("motorist.workplace.resume.v1:77777777-7777-4777-8777-777777777777"),
    }))).toEqual({ mutation: null, resume: null, credential: null });
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("stratená resume odpoveď sa po reloade prehrá s pôvodným fence a až potom presunie do nového okna", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      actorExtension: "20",
      dropResumeResponseOnce: true,
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(
      () => api.droppedPresenceBodies.filter((body) => body.action === "resume").length,
      { intervals: [10, 10, 20], timeout: 5_000 },
    ).toBe(1);
    expect(api.presenceBodies.filter((body) => body.action === "resume")).toHaveLength(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 });
    await expect.poll(() => api.presenceBodies.filter((body) => body.action === "resume").length).toBeGreaterThanOrEqual(3);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);

    const resumes = api.presenceBodies.filter((body) => body.action === "resume");
    expect(resumes[1]).toEqual(resumes[0]);
    expect(resumes[2].browserInstanceId).not.toBe(resumes[0].browserInstanceId);
    expect(resumes[2].idempotencyKey).toBe(resumes[2].browserInstanceId);
    expect(resumes[2].resumeSecret).not.toBe(resumes[0].resumeSecret);
    expect(api.webphoneSessionBodies[0].browserInstanceId).toBe(resumes[2].browserInstanceId);
    const lostIndex = api.events.indexOf("presence:resume:committed_response_lost");
    const snapshotIndex = api.events.indexOf("selection:get", lostIndex + 1);
    const replayIndex = api.events.indexOf("presence:resume:replayed", snapshotIndex + 1);
    const newDocumentResumeIndex = api.events.indexOf("presence:resume:responded", replayIndex + 1);
    const webphoneIndex = api.events.indexOf("webphone:session", newDocumentResumeIndex + 1);
    expect(snapshotIndex).toBeGreaterThan(lostIndex);
    expect(replayIndex).toBeGreaterThan(snapshotIndex);
    expect(newDocumentResumeIndex).toBeGreaterThan(replayIndex);
    expect(webphoneIndex).toBeGreaterThan(newDocumentResumeIndex);
    expect(api.events.slice(snapshotIndex, webphoneIndex)).not.toContain("presence:heartbeat:received");
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("druhý tab zostane follower a neotočí lease ani nepripojí druhý telefón", async ({ page, context }) => {
    const api = await installHotdeskApiFirewall(page, { actorExtension: "20" });
    await openWorkplace(page);
    await expect.poll(() => api.webphoneSessionBodies.length).toBe(1);
    const activeSession = api.webphoneSessionBodies[0];
    const resumeStorageKey = `motorist.workplace.resume.v1:${activeSession.leaseId}`;
    const activeCredential = await page.evaluate((key) => sessionStorage.getItem(key), resumeStorageKey);
    expect(activeCredential).not.toBeNull();

    const resumeCountBeforeFollower = api.presenceBodies.filter((body) => body.action === "resume").length;
    const sessionCountBeforeFollower = api.webphoneSessionBodies.length;
    const follower = await context.newPage();
    await follower.addInitScript(({ key, value }) => {
      if (value) sessionStorage.setItem(key, value);
    }, { key: resumeStorageKey, value: activeCredential });
    await follower.goto("/", { waitUntil: "domcontentloaded" });
    await expect(follower.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 });
    await follower.waitForTimeout(900);

    expect(api.presenceBodies.filter((body) => body.action === "resume")).toHaveLength(resumeCountBeforeFollower);
    expect(api.webphoneSessionBodies).toHaveLength(sessionCountBeforeFollower);

    const heartbeatCountBefore = api.presenceBodies.filter((body) => body.action !== "resume").length;
    await page.bringToFront();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => api.presenceBodies.filter((body) => body.action !== "resume").length).toBeGreaterThan(heartbeatCountBefore);
    const latestHeartbeat = api.presenceBodies.filter((body) => body.action !== "resume").at(-1);
    expect(latestHeartbeat?.browserInstanceId).toBe(activeSession.browserInstanceId);
    expect(api.webphoneSessionBodies).toHaveLength(sessionCountBeforeFollower);
    expect(api.unexpectedRequests).toEqual([]);
    await follower.close();
  });

  test("prevzaté miesto v stave Pauza sa lease-fenced prepne na Dostupný", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      pausedExtensions: ["21"],
      queueAssignments: { "601": "21" },
      staleExtensions: ["21"],
    });
    await openWorkplace(page);
    await page.getByRole("button", {
      name: "Obsadiť pracovné miesto 2, interná linka 21, po offline operátorovi Mango Mango",
      exact: true,
    }).click();

    await expect.poll(() => api.queueAgentBodies.length).toBe(1);
    expect(api.queueAgentBodies[0]).toMatchObject({
      action: "available",
      extension: "21",
      assignmentGeneration: expect.any(String),
      browserInstanceId: expect.any(String),
      leaseId: expect.any(String),
      leaderEpoch: expect.any(Number),
      leaseVersion: expect.any(Number),
    });
    await expect(page.getByRole("status").filter({
      hasText: "Pracovné miesto 21 je pripravené a tvoj stav je Dostupný.",
    })).toBeVisible();
    await expect(page.locator('[data-workplace-station="21"]').getByText("Pripravený", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("zlyhané zrušenie Pauzy pravdivo ponechá miesto iba na odchádzajúce hovory", async ({ page }) => {
    const api = await installHotdeskApiFirewall(page, {
      failAvailableCommand: true,
      pausedExtensions: ["21"],
      queueAssignments: { "601": "21" },
      staleExtensions: ["21"],
    });
    await openWorkplace(page);
    await page.getByRole("button", {
      name: "Obsadiť pracovné miesto 2, interná linka 21, po offline operátorovi Mango Mango",
      exact: true,
    }).click();

    await expect.poll(() => api.queueAgentBodies.length).toBe(1);
    await expect(page.getByRole("status").filter({
      hasText: /Pracovné miesto 21 je pripravené.*Stav Dostupný sa zatiaľ nepotvrdil/,
    })).toBeVisible();
    await expect(page.locator('[data-workplace-station="21"]').getByText("Pauza", { exact: true })).toBeVisible();
    await expect(page.getByText("Telefón je pripojený iba pre odchádzajúce a interné hovory. Pre príjem hovorov zvoľ Dostupný a obnov stav.", { exact: true })).toBeVisible();
    expect(api.unexpectedRequests).toEqual([]);
  });
});

type ExtensionNumber = (typeof workplaceExtensions)[number];
type QueueNumber = "601" | "602" | "603";
type SeatOwnerState = "active" | "actor" | "free" | "stale";
const priorityRecoveryOperationId = "77777777-7777-4777-8777-777777777777";
const takeoverRequestId = "88888888-8888-4888-8888-888888888888";

function emptyTakeoverSnapshot(cooldownExtension?: ExtensionNumber) {
  return {
    checkedAt: new Date().toISOString(),
    cooldowns: cooldownExtension
      ? [{ extension: cooldownExtension, until: new Date(Date.now() + 300_000).toISOString() }]
      : [],
  };
}

function takeoverFixture(
  direction: "incoming" | "outgoing",
  actorProfileId: string,
  extension: ExtensionNumber,
  status: "accepted" | "pending" = "pending",
) {
  const checkedAt = new Date().toISOString();
  const request = {
    requestId: takeoverRequestId,
    extensionId: "22222222-2222-4222-8222-222222222222",
    extension,
    leaseId: "33333333-3333-4333-8333-333333333333",
    requesterProfileId: direction === "outgoing" ? actorProfileId : "op-requester",
    requesterName: direction === "outgoing" ? "Natalia Natali" : "Peter Kolega",
    ownerProfileId: direction === "incoming" ? actorProfileId : "op-mango",
    ownerName: direction === "incoming" ? "Natalia Natali" : "Mango Mango",
    requestedAt: checkedAt,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    status,
    ...(status === "accepted" ? {
      acceptedBy: "timeout" as const,
      respondedAt: checkedAt,
      handoffExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    } : {}),
  };
  return { checkedAt, [direction]: request };
}

type HotdeskApiOptions = {
  activeExtensions?: ExtensionNumber[];
  actorExtension?: ExtensionNumber;
  actorProfileId?: string;
  blockPriorityAfterClaimOnce?: boolean;
  incomingTakeoverRequest?: boolean;
  claimsDisabled?: boolean;
  confirmDelayMs?: number;
  confirmChangeFails?: boolean;
  confirmUnregisterPendingOnce?: boolean;
  dropConfirmResponseOnce?: boolean;
  dropResumeResponseOnce?: boolean;
  dropSelectResponseOnce?: boolean;
  expiredActorLease?: boolean;
  failAvailableCommand?: boolean;
  failPostReleaseProviderRefresh?: boolean;
  omitWorkplaceOnCommittedSelect?: boolean;
  omitInitialResumeCredential?: boolean;
  outgoingAcceptedTakeoverExtension?: ExtensionNumber;
  pausedExtensions?: ExtensionNumber[];
  precommitAborted?: boolean;
  priorityRecoveryBlocked?: boolean;
  priorityRecoveryFailures?: number;
  providerRefreshChangesSeatVersion?: boolean;
  queueAssignments?: Partial<Record<QueueNumber, ExtensionNumber>>;
  recoverPriorityOnSeatSelect?: boolean;
  retainedExpiredActorLease?: boolean;
  selectDelayMs?: number;
  selectTransportFailures?: number;
  staleExtensions?: ExtensionNumber[];
  storedPresenceDelayMs?: number;
  timedOutTakeoverRequest?: boolean;
  takeoverCooldownExtension?: ExtensionNumber;
  webphoneSessionDelayMs?: number;
};

async function installHotdeskApiFirewall(page: Page, options: HotdeskApiOptions = {}) {
  const patchBodies: Array<Record<string, unknown>> = [];
  const presenceBodies: Array<Record<string, unknown>> = [];
  const queueAgentBodies: Array<Record<string, unknown>> = [];
  const webphoneSessionBodies: Array<Record<string, unknown>> = [];
  const callCreateBodies: Array<Record<string, unknown>> = [];
  const takeoverBodies: Array<Record<string, unknown>> = [];
  const unexpectedRequests: string[] = [];
  const events: string[] = [];
  const droppedPatchBodies: Array<Record<string, unknown>> = [];
  const droppedPresenceBodies: Array<Record<string, unknown>> = [];
  const failedWebphoneSessionRequests: string[] = [];
  const selectionResponseCache = new Map<string, { json: Record<string, unknown>; status: number }>();
  const resumeResponseCache = new Map<string, { json: Record<string, unknown>; status: number }>();
  const state = hotdeskState(options, events);
  let loseLease = false;
  let leaseLostResponses = 0;
  let claimsDisabled = options.claimsDisabled ?? false;
  let dropConfirmResponse = options.dropConfirmResponseOnce ?? false;
  let confirmUnregisterPending = options.confirmUnregisterPendingOnce ?? false;
  let dropResumeResponse = options.dropResumeResponseOnce ?? false;
  let dropSelectResponse = options.dropSelectResponseOnce ?? false;
  let nextSelectConflictWithoutCode = false;
  let nextSelectLeaseLost = false;
  let selectTransportFailures = options.selectTransportFailures ?? 0;
  let blockPriorityAfterClaim = options.blockPriorityAfterClaimOnce ?? false;
  let takeoverSnapshot: WorkplaceTakeoverSnapshot = options.outgoingAcceptedTakeoverExtension
    ? takeoverFixture(
        "outgoing",
        options.actorProfileId ?? "op-natalia",
        options.outgoingAcceptedTakeoverExtension,
        "accepted",
      )
    : options.incomingTakeoverRequest
    ? takeoverFixture(
        "incoming",
        options.actorProfileId ?? "op-natalia",
        "21",
        options.timedOutTakeoverRequest ? "accepted" : "pending",
      )
    : emptyTakeoverSnapshot(options.takeoverCooldownExtension);

  const initialLease = state.lease();
  if (initialLease && !options.retainedExpiredActorLease && !options.omitInitialResumeCredential) {
    await page.addInitScript(({ lease, resumeSecret }) => {
      try {
        const key = `motorist.workplace.resume.v1:${lease.leaseId}`;
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, JSON.stringify({
            browserInstanceId: "99999999-9999-4999-8999-999999999999",
            leaseId: lease.leaseId,
            resumeSecret,
          }));
        }
      } catch {
        // The target-origin document will run this script again after about:blank.
      }
    }, { lease: initialLease, resumeSecret: `resume-${initialLease.leaseId}` });
  }

  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname !== "/api/telephony/webphone/session") return;
    failedWebphoneSessionRequests.push(request.failure()?.errorText ?? "unknown");
    events.push("webphone:session:requestfailed");
  });

  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/workplace-takeover" && method === "GET") {
      if (
        takeoverSnapshot.incoming?.status === "accepted" &&
        !state.actorOwns(takeoverSnapshot.incoming.extension)
      ) {
        takeoverSnapshot = emptyTakeoverSnapshot();
      }
      return fulfillJson(route, { ok: true, takeover: takeoverSnapshot });
    }
    if (url.pathname === "/api/telephony/workplace-takeover" && method === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      takeoverBodies.push(body);
      if (body.action === "request" && isExtension(body.extension)) {
        takeoverSnapshot = takeoverFixture("outgoing", options.actorProfileId ?? "op-natalia", body.extension);
        return fulfillJson(route, { ok: true, message: "Žiadosť je odoslaná.", snapshot: takeoverSnapshot });
      }
      if (body.action === "cancel" || (body.action === "respond" && body.decision === "decline")) {
        takeoverSnapshot = emptyTakeoverSnapshot();
        return fulfillJson(route, { ok: true, message: "Žiadosť je uzavretá.", snapshot: takeoverSnapshot });
      }
      if (body.action === "complete") {
        takeoverSnapshot = emptyTakeoverSnapshot();
        return fulfillJson(route, { ok: true, message: "Pracovisko je odovzdané.", snapshot: takeoverSnapshot });
      }
      if (body.action === "respond" && body.decision === "accept" && takeoverSnapshot.incoming) {
        takeoverSnapshot = {
          checkedAt: freshTime(),
          incoming: {
            ...takeoverSnapshot.incoming,
            status: "accepted",
            respondedAt: freshTime(),
            handoffExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        };
        return fulfillJson(route, { ok: true, message: "Odovzdanie je schválené.", snapshot: takeoverSnapshot });
      }
      unexpectedRequests.push(`${method} ${url.pathname} ${JSON.stringify(body)}`);
      return fulfillJson(route, { ok: false, error: "QA zablokovalo neočakávanú žiadosť." }, 599);
    }

    if (url.pathname === "/api/telephony/workplace-selection" && method === "GET") {
      events.push("selection:get");
      return fulfillJson(route, { ok: true, workplace: state.snapshot() });
    }
    if (url.pathname === "/api/telephony/workplace-selection" && method === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      patchBodies.push(body);
      const action = typeof body.action === "string" ? body.action : "unknown";
      events.push(`patch:${action}:received`);
      const cacheKey = typeof body.idempotencyKey === "string" &&
        ["select_seat", "leave_seat", "confirm_seat_change"].includes(action)
        ? `${action}:${body.idempotencyKey}`
        : null;
      const cached = cacheKey ? selectionResponseCache.get(cacheKey) : undefined;
      if (cached) {
        events.push(`patch:${action}:replayed`);
        return fulfillJson(route, cached.json, cached.status);
      }

      let json: Record<string, unknown> | null = null;
      let status = 200;
      if (body.action === "select_seat" && isExtension(body.extension)) {
        if (selectTransportFailures > 0) {
          selectTransportFailures -= 1;
          events.push("patch:select_seat:transport_failure");
          await route.abort("connectionfailed");
          return;
        }
        if (nextSelectConflictWithoutCode) {
          nextSelectConflictWithoutCode = false;
          json = {
            ok: false,
            error: "Pracovné miesto medzitým zmenila iná požiadavka.",
          };
          status = 409;
        } else if (nextSelectLeaseLost) {
          nextSelectLeaseLost = false;
          json = {
            ok: false,
            code: "lease_lost",
            error: "Aktuálne pracovisko používa iné okno alebo reláciu.",
          };
          status = 409;
        } else {
          if (options.selectDelayMs) await new Promise((resolve) => setTimeout(resolve, options.selectDelayMs));
          if (claimsDisabled) {
            json = {
              ok: false,
              code: "hotdesk_claims_disabled",
              error: "Nové obsadenie pracoviska je dočasne pozastavené.",
            };
            status = 503;
          } else if (options.precommitAborted) {
            json = {
              ok: false,
              code: "workplace_precommit_aborted",
              error: "Predchádzajúca zmena bola bezpečne zrušená. Vytvor novú požiadavku.",
            };
            status = 409;
          } else {
            json = { ...state.prepareSelect(body.extension) } as Record<string, unknown>;
            if (options.omitWorkplaceOnCommittedSelect && json.result && json.lease) {
              delete json.workplace;
            }
          }
        }
      }
      if (!json && body.action === "leave_seat") {
        json = { ...state.prepareLeave() } as Record<string, unknown>;
      }
      if (!json && body.action === "confirm_seat_change" && typeof body.operationId === "string") {
        if (options.confirmDelayMs) await new Promise((resolve) => setTimeout(resolve, options.confirmDelayMs));
        if (confirmUnregisterPending) {
          confirmUnregisterPending = false;
          events.push("patch:confirm_seat_change:unregister_pending");
          json = {
            ok: false,
            code: "workplace_source_unregister_pending",
            error: "VIPTel ešte nepotvrdil odregistrovanie zdrojového telefónu.",
          };
          status = 423;
        } else {
          json = { ...state.confirmChange(body.operationId) } as Record<string, unknown>;
        }
      }
      if (!json && body.action === "cancel_seat_change" && typeof body.operationId === "string") {
        return fulfillJson(route, state.cancelChange(body.operationId));
      }
      if (!json && body.action === "claim_priority" && isQueue(body.queue)) {
        if (blockPriorityAfterClaim) {
          blockPriorityAfterClaim = false;
          state.blockPriorityRecovery();
          return fulfillJson(route, state.claimPriority(body.queue), 202);
        }
        return fulfillJson(route, state.claimPriority(body.queue));
      }
      if (!json && body.action === "recover_priority") {
        const recovered = state.recoverPriority(body);
        return fulfillJson(route, recovered.json, recovered.status);
      }
      if (json) {
        if (cacheKey && json.ok === true) selectionResponseCache.set(cacheKey, { json, status });
        const shouldDrop = json.ok === true && (
          (action === "select_seat" && dropSelectResponse) ||
          (action === "confirm_seat_change" && dropConfirmResponse)
        );
        if (shouldDrop) {
          if (action === "select_seat") dropSelectResponse = false;
          if (action === "confirm_seat_change") dropConfirmResponse = false;
          droppedPatchBodies.push(body);
          events.push(`patch:${action}:committed_response_lost`);
          await route.abort("connectionfailed");
          return;
        }
        events.push(`patch:${action}:responded`);
        return fulfillJson(route, json, status);
      }
      unexpectedRequests.push(`${method} ${url.pathname} ${JSON.stringify(body)}`);
      return fulfillJson(route, { ok: false, error: "QA zablokovalo neočakávanú mutáciu pracoviska." }, 599);
    }
    if (url.pathname === "/api/telephony/workplace-presence" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      presenceBodies.push(body);
      events.push(`presence:${body.action === "resume" ? "resume" : "heartbeat"}:received`);
      if (loseLease) {
        loseLease = false;
        leaseLostResponses += 1;
        state.loseActorLease();
        return fulfillJson(route, {
          ok: false,
          code: "lease_lost",
          error: "Pracovné miesto medzitým bezpečne prevzal iný operátor.",
        }, 410);
      }
      const lease = state.lease();
      if (!lease) return fulfillJson(route, { ok: false, code: "lease_lost", error: "Lease už nie je aktívna." }, 410);
      if (body.action === "resume" && typeof body.idempotencyKey === "string") {
        const cacheKey = `resume:${body.idempotencyKey}`;
        const cached = resumeResponseCache.get(cacheKey);
        if (cached) {
          events.push("presence:resume:replayed");
          return fulfillJson(route, cached.json, cached.status);
        }
        const resumed = state.resume(body);
        resumeResponseCache.set(cacheKey, resumed);
        if (dropResumeResponse) {
          dropResumeResponse = false;
          droppedPresenceBodies.push(body);
          events.push("presence:resume:committed_response_lost");
          await route.abort("connectionfailed");
          return;
        }
        events.push("presence:resume:responded");
        return fulfillJson(route, resumed.json, resumed.status);
      }
      events.push("presence:heartbeat:responded");
      return fulfillJson(route, { ok: true, lease });
    }
    if (url.pathname === "/api/telephony/presence" && (method === "GET" || method === "POST")) {
      events.push(`telephony-presence:${method === "POST" ? "provider" : "stored"}`);
      if (method === "GET" && options.storedPresenceDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.storedPresenceDelayMs));
      }
      if (method === "POST" && options.failPostReleaseProviderRefresh && state.releaseProviderSyncPending()) {
        events.push("telephony-presence:provider:failed");
        return fulfillJson(route, {
          ok: false,
          error: "Simulované zlyhanie následnej VIPTel synchronizácie.",
        }, 503);
      }
      if (method === "POST" && options.providerRefreshChangesSeatVersion) {
        state.refreshProviderSnapshot();
      }
      if (method === "POST") state.synchronizeProviderPresence();
      return fulfillJson(route, {
        ok: true,
        source: method === "POST" ? "provider_refresh" : "stored",
        actorRouting: state.actorQueue() ? { queue: state.actorQueue(), revision: 11 } : null,
        routingDiagnostic: null,
        snapshot: state.presence(),
      });
    }
    if (url.pathname === "/api/telephony/webphone/config" && method === "GET") {
      events.push("webphone:config");
      return fulfillJson(route, state.webphoneConfig());
    }
    if (url.pathname === "/api/telephony/webphone/session" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      webphoneSessionBodies.push(body);
      events.push("webphone:session");
      if (options.webphoneSessionDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.webphoneSessionDelayMs));
      }
      if (!state.sessionFenceMatches(body)) {
        return fulfillJson(route, { ok: false, error: "Lease fence sa nezhoduje." }, 409);
      }
      state.registerActorWebphone();
      return fulfillJson(route, { ok: false, error: "Izolovaný QA mock nevydáva reálnu SIP session." }, 409);
    }
    if (url.pathname === "/api/telephony/call/create" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      callCreateBodies.push(body);
      if (!state.commandFenceMatches(body)) {
        return fulfillJson(route, { ok: false, error: "Lease fence telefónneho príkazu sa nezhoduje." }, 409);
      }
      return fulfillJson(route, {
        ok: true,
        command: { id: "hotdesk-call-1", status: "queued" },
      });
    }
    if (url.pathname === "/api/telephony/commands/hotdesk-call-1" && method === "GET") {
      return fulfillJson(route, {
        ok: true,
        command: { id: "hotdesk-call-1", status: "confirmed_by_event" },
      });
    }
    if (url.pathname === "/api/telephony/calls/active" && method === "GET") {
      return fulfillJson(route, { ok: true, checkedAt: freshTime(), calls: [] });
    }
    if (url.pathname === "/api/telephony/calls/history" && method === "GET") {
      return fulfillJson(route, { ok: true, calls: [] });
    }
    if (url.pathname === "/api/telephony/calls/match" && method === "GET") {
      return fulfillJson(route, { ok: true, number: url.searchParams.get("number") ?? "", matches: [] });
    }
    if (url.pathname === "/api/telephony/directory" && method === "GET") {
      return fulfillJson(route, { contacts: [] });
    }
    if (url.pathname === "/api/telephony/directory/favorites" && method === "GET") {
      return fulfillJson(route, { favorites: [] });
    }
    if (url.pathname === "/api/telephony/routing/lines" && method === "GET") {
      return fulfillJson(route, { ok: true, gate: { enabled: false, reason: "flag_disabled" }, plan: [] });
    }
    if (url.pathname === "/api/telephony/queues/agent" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      queueAgentBodies.push(body);
      if (options.failAvailableCommand && body.action === "available") {
        return fulfillJson(route, { ok: false, error: "VIPTel simulovane nepotvrdil zrušenie pauzy." }, 409);
      }
      if (body.action === "available" && isExtension(body.extension)) {
        state.setAvailable(body.extension);
      }
      return fulfillJson(route, { ok: true, queue: state.actorQueue(), command: { id: "availability-1", status: "queued" } });
    }
    if (url.pathname === "/api/telephony/commands/availability-1" && method === "GET") {
      return fulfillJson(route, { ok: true, command: { id: "availability-1", status: "confirmed_by_event" } });
    }

    unexpectedRequests.push(`${method} ${url.pathname}`);
    return fulfillJson(route, { error: "QA API firewall zablokoval neočakávanú požiadavku." }, 599);
  });

  return {
    callCreateBodies,
    droppedPatchBodies,
    droppedPresenceBodies,
    events,
    failedWebphoneSessionRequests,
    initialLeaseId: initialLease?.leaseId,
    patchBodies,
    presenceBodies,
    queueAgentBodies,
    takeoverBodies,
    queueAssignments: state.queueAssignments,
    unexpectedRequests,
    webphoneSessionBodies,
    enableClaims: () => { claimsDisabled = false; },
    makeNextSelectConflictWithoutCode: () => { nextSelectConflictWithoutCode = true; },
    makeNextSelectLeaseLost: () => { nextSelectLeaseLost = true; },
    loseLeaseOnNextHeartbeat: () => { loseLease = true; },
    get leaseLostResponses() { return leaseLostResponses; },
  };
}

function hotdeskState(options: HotdeskApiOptions, events: string[] = []) {
  const actorProfileId = options.actorProfileId ?? "op-natalia";
  const seats = new Map<ExtensionNumber, SeatOwnerState>(workplaceExtensions.map((extensionNumber) => [extensionNumber, "free"]));
  for (const extensionNumber of options.staleExtensions ?? []) seats.set(extensionNumber, "stale");
  for (const extensionNumber of options.activeExtensions ?? []) seats.set(extensionNumber, "active");
  if (options.actorExtension) seats.set(options.actorExtension, "actor");
  const queues: Record<QueueNumber, ExtensionNumber | null> = {
    "601": options.queueAssignments?.["601"] ?? null,
    "602": options.queueAssignments?.["602"] ?? null,
    "603": options.queueAssignments?.["603"] ?? null,
  };
  const pausedExtensions = new Set(options.pausedExtensions ?? []);
  let actorExtension = options.actorExtension ?? null;
  let actorRegistered = false;
  let leaseVersion = 1;
  let leaseSequence = 0;
  const issueLease = (extensionNumber: ExtensionNumber, expired = false) =>
    makeLease(extensionNumber, leaseVersion, ++leaseSequence, expired);
  let currentLeaseExpired = Boolean(options.retainedExpiredActorLease);
  let currentLease = actorExtension && (!options.expiredActorLease || options.retainedExpiredActorLease)
    ? issueLease(actorExtension, currentLeaseExpired)
    : null;
  let currentResumeSecret = currentLease ? `resume-${currentLease.leaseId}` : null;
  let resumeSequence = 0;
  let pending: { kind: "leave" | "switch"; operationId: string; target?: ExtensionNumber } | null = null;
  let releasedRegistrationPending: ExtensionNumber | null = null;
  let priorityRecoveryBlocked = options.priorityRecoveryBlocked === true;
  let priorityRecoveryFailures = options.priorityRecoveryFailures ?? 0;

  const owner = (extensionNumber: ExtensionNumber) => {
    const status = seats.get(extensionNumber);
    if (status === "actor") return { profileId: actorProfileId, profileName: "Natália" };
    if (status === "stale") return { profileId: `op-stale-${extensionNumber}`, profileName: "Mango Mango" };
    if (status === "active") return { profileId: `op-active-${extensionNumber}`, profileName: "Michal Aktívny" };
    return undefined;
  };

  const queueForExtension = (extensionNumber: ExtensionNumber) =>
    (Object.entries(queues).find(([, value]) => value === extensionNumber)?.[0] as QueueNumber | undefined) ?? null;

  const snapshot = () => ({
    checkedAt: freshTime(),
    lease: currentLease,
    selection: {
      seatId: actorExtension ? `seat-${actorExtension}` : null,
      extension: actorExtension,
      queue: actorExtension ? queueForExtension(actorExtension) : null,
    },
    seats: workplaceExtensions.map((extensionNumber) => {
      const ownerValue = owner(extensionNumber);
      const status = seats.get(extensionNumber) ?? "free";
      const canonicalStatus = releasedRegistrationPending === extensionNumber
        ? "unknown"
        : status === "actor" ? "mine" : status;
      const reason = canonicalStatus === "free"
        ? "Miesto je voľné a môžeš ho použiť."
        : canonicalStatus === "mine"
          ? "Toto pracovné miesto práve používaš."
          : canonicalStatus === "stale"
            ? `${ownerValue?.profileName} je offline. Miesto môžeš bezpečne obsadiť.`
            : canonicalStatus === "unknown"
              ? "Odpojenie je potvrdené, ale uložený stav VIPTel ešte nebol obnovený."
              : `${ownerValue?.profileName} je aktívny. Počas pripojenia, zvonenia alebo hovoru miesto nemožno prevziať.`;
      return {
        seatId: `seat-${extensionNumber}`,
        extension: extensionNumber,
        status: canonicalStatus,
        canSelect: canonicalStatus === "free" || canonicalStatus === "stale" || canonicalStatus === "mine",
        reasonCode: canonicalStatus,
        reason,
        owner: ownerValue,
        profileId: ownerValue?.profileId,
        profileName: ownerValue?.profileName,
        heartbeatFresh: canonicalStatus === "active" || canonicalStatus === "mine",
        registered: canonicalStatus === "unknown" || canonicalStatus === "active" ||
          (canonicalStatus === "mine" && actorRegistered),
        hasActiveCall: false,
        queueInUse: false,
        nextEligibleAt: canonicalStatus === "stale" ? freshTime() : undefined,
        priority: queueForExtension(extensionNumber),
        outboundOnly: queueForExtension(extensionNumber) === null,
        version: `seat-${extensionNumber}-v${leaseVersion}`,
      };
    }),
    priorities: (["601", "602", "603"] as const).map((queue, index) => {
      const extensionNumber = queues[queue];
      const ownerValue = extensionNumber ? owner(extensionNumber) : undefined;
      const mine = extensionNumber === actorExtension;
      return {
        queue,
        order: (index + 1) as 1 | 2 | 3,
        activeExtension: extensionNumber,
        selectedExtension: extensionNumber,
        status: mine ? "mine" : extensionNumber ? "occupied" : "available",
        selectionEffect: mine ? "mine" : extensionNumber ? "replace" : "claim",
        profileId: ownerValue?.profileId,
        profileName: ownerValue?.profileName,
        willDisplace: extensionNumber && ownerValue ? { extension: extensionNumber, ...ownerValue } : undefined,
      };
    }),
    routingStatus: {
      state: priorityRecoveryBlocked ? "blocked" : Object.values(queues).some(Boolean) ? "active" : "collecting",
      selectedCount: Object.values(queues).filter(Boolean).length,
      capacityCount: 3,
      operationId: priorityRecoveryBlocked ? priorityRecoveryOperationId : undefined,
      canRecover: priorityRecoveryBlocked || undefined,
      message: priorityRecoveryBlocked
        ? "VIPTel listener odmietol príkaz. Poradie môžeš bezpečne obnoviť."
        : Object.values(queues).some(Boolean)
        ? "Poradie zvonenia je aktívne."
        : "Pracovné miesto a poradie sa potvrdzujú oddelene.",
    },
  });

  return {
    actorOwns: (extensionNumber: string) => actorExtension === extensionNumber,
    actorQueue: () => actorExtension ? queueForExtension(actorExtension) : null,
    blockPriorityRecovery: () => { priorityRecoveryBlocked = true; },
    cancelChange: (operationId: string) => {
      if (!pending || pending.operationId !== operationId || !actorExtension) {
        return { ok: false, error: "Zmena pracovného miesta už nie je aktívna." };
      }
      pending = null;
      leaseVersion += 1;
      currentLease = issueLease(actorExtension);
      currentLeaseExpired = false;
      currentResumeSecret = `resume-${currentLease.leaseId}`;
      return {
        ok: true,
        result: { state: "confirmed", message: "Pôvodné pracovné miesto bolo obnovené." },
        workplace: snapshot(),
        lease: currentLease,
        resumeSecret: currentResumeSecret,
      };
    },
    claimPriority: (queue: QueueNumber) => {
      if (!actorExtension || !actorRegistered) {
        return { ok: false, error: "Telefón ešte nie je pripravený." };
      }
      for (const queueNumber of ["601", "602", "603"] as const) {
        if (queues[queueNumber] === actorExtension) queues[queueNumber] = null;
      }
      queues[queue] = actorExtension;
      return {
        ok: true,
        result: { state: "confirmed", message: "Poradie potvrdil VIPTel." },
        workplace: snapshot(),
      };
    },
    recoverPriority: (body: Record<string, unknown>) => {
      const valid = Boolean(
        priorityRecoveryBlocked && actorRegistered &&
        body.operationId === priorityRecoveryOperationId &&
        currentLease &&
        body.leaseId === currentLease.leaseId &&
        body.assignmentGeneration === currentLease.assignmentGeneration &&
        typeof body.browserInstanceId === "string" &&
        body.leaderEpoch === currentLease.leaderEpoch &&
        body.leaseVersion === currentLease.leaseVersion,
      );
      if (!valid) {
        return {
          json: { ok: false, error: "Obnova nemá presnú vlastnú reláciu alebo telefón ešte nie je pripravený." },
          status: 409,
        };
      }
      if (priorityRecoveryFailures > 0) {
        priorityRecoveryFailures -= 1;
        return {
          json: { ok: false, error: "Simulované zlyhanie obnovy poradia." },
          status: 409,
        };
      }
      priorityRecoveryBlocked = false;
      return {
        json: {
          ok: true,
          result: { state: "pending", operationId: priorityRecoveryOperationId, message: "Obnova poradia bola spustená." },
          workplace: snapshot(),
        },
        status: 202,
      };
    },
    confirmChange: (operationId: string) => {
      if (!pending || pending.operationId !== operationId) {
        return { ok: false, error: "Zmena pracovného miesta už nie je aktívna." };
      }
      if (options.confirmChangeFails) {
        return { ok: false, error: "Simulované zlyhanie potvrdenia presunu." };
      }
      const releasedExtension = actorExtension;
      if (releasedExtension) seats.set(releasedExtension, "free");
      if (pending.kind === "leave") {
        releasedRegistrationPending = releasedExtension;
        actorExtension = null;
        currentLease = null;
        currentLeaseExpired = false;
        currentResumeSecret = null;
      } else if (pending.target) {
        actorExtension = pending.target;
        seats.set(actorExtension, "actor");
        leaseVersion += 1;
        currentLease = issueLease(actorExtension);
        currentLeaseExpired = false;
        currentResumeSecret = `resume-${currentLease.leaseId}`;
      }
      actorRegistered = false;
      pending = null;
      return {
        ok: true,
        result: { state: "confirmed", message: actorExtension ? "Nové pracovné miesto je tvoje." : "Pracovné miesto je uvoľnené." },
        workplace: snapshot(),
        lease: currentLease,
        resumeSecret: currentResumeSecret ?? undefined,
      };
    },
    lease: () => currentLease,
    releaseProviderSyncPending: () => releasedRegistrationPending !== null,
    loseActorLease: () => {
      if (actorExtension) seats.set(actorExtension, "stale");
      actorExtension = null;
      actorRegistered = false;
      currentLease = null;
      currentLeaseExpired = false;
      currentResumeSecret = null;
    },
    prepareLeave: () => {
      if (!actorExtension) return { ok: true, result: { state: "confirmed", message: "Nemáš aktívne miesto." }, workplace: snapshot() };
      actorRegistered = false;
      pending = { kind: "leave", operationId: "00000000-0000-4000-8000-000000000091" };
      return {
        ok: true,
        result: { state: "disconnect_required", operationId: pending.operationId, message: "Najprv odpoj telefón." },
        workplace: snapshot(),
        lease: currentLease,
      };
    },
    prepareSelect: (target: ExtensionNumber) => {
      if (seats.get(target) === "active" && options.outgoingAcceptedTakeoverExtension !== target) {
        return { ok: false, error: "Aktívne miesto nemožno prevziať." };
      }
      if (options.recoverPriorityOnSeatSelect && priorityRecoveryBlocked) {
        priorityRecoveryBlocked = false;
        events.push("server:routing_recovered:select_seat");
      }
      if (actorExtension && actorExtension !== target) {
        actorRegistered = false;
        pending = { kind: "switch", operationId: "00000000-0000-4000-8000-000000000092", target };
        return {
          ok: true,
          result: { state: "disconnect_required", operationId: pending.operationId, message: "Najprv odpoj pôvodný telefón." },
          workplace: snapshot(),
          lease: currentLease,
        };
      }
      if (!actorExtension) {
        actorExtension = target;
        seats.set(target, "actor");
        leaseVersion += 1;
        currentLease = issueLease(target);
        currentLeaseExpired = false;
        currentResumeSecret = `resume-${currentLease.leaseId}`;
      } else if (actorExtension === target && (!currentLease || currentLeaseExpired)) {
        leaseVersion += 1;
        currentLease = issueLease(target);
        currentLeaseExpired = false;
        currentResumeSecret = `resume-${currentLease.leaseId}`;
      }
      return {
        ok: true,
        result: { state: "confirmed", message: "Pracovné miesto je tvoje. Telefón pripájam automaticky." },
        workplace: snapshot(),
        lease: currentLease,
        resumeSecret: currentResumeSecret ?? undefined,
      };
    },
    presence: () => ({
      actorProfileId,
      canManageAssignments: false,
      checkedAt: freshTime(),
      extensions: workplaceExtensions.map((extensionNumber) => {
        const ownerValue = owner(extensionNumber);
        const status = seats.get(extensionNumber);
        return extension(
          extensionNumber,
          ownerValue?.profileId,
          ownerValue?.profileName ?? `Pracovné miesto ${Number(extensionNumber) - 19}`,
          status === "active" || (status === "actor" && actorRegistered),
        );
      }),
      queues: ["601", "602", "603"].map((queue) => ({ id: `q-${queue}`, name: queue })),
      queueStatuses: (["601", "602", "603"] as const).map((queue) => {
        const extensionNumber = queues[queue] ?? undefined;
        return queueStatus(queue, extensionNumber, extensionNumber ? pausedExtensions.has(extensionNumber) : false);
      }),
    }),
    queueAssignments: () => ({ ...queues }),
    refreshProviderSnapshot: () => { leaseVersion += 1; },
    synchronizeProviderPresence: () => { releasedRegistrationPending = null; },
    registerActorWebphone: () => { actorRegistered = true; },
    resume: (body: Record<string, unknown>) => {
      const valid = Boolean(
        currentLease &&
        currentResumeSecret &&
        body.leaseId === currentLease.leaseId &&
        body.assignmentGeneration === currentLease.assignmentGeneration &&
        body.leaderEpoch === currentLease.leaderEpoch &&
        body.leaseVersion === currentLease.leaseVersion &&
        body.resumeSecret === currentResumeSecret &&
        typeof body.browserInstanceId === "string",
      );
      if (!valid || !currentLease) {
        return {
          json: { ok: false, code: "lease_lost", error: "Obnovovací fence sa nezhoduje." },
          status: 410,
        };
      }
      resumeSequence += 1;
      currentResumeSecret = `rotated_${String(resumeSequence).padStart(4, "0")}_${currentLease.leaseId.replaceAll("-", "")}`;
      return {
        json: { ok: true, lease: currentLease, resumeSecret: currentResumeSecret },
        status: 200,
      };
    },
    setAvailable: (extensionNumber: ExtensionNumber) => { pausedExtensions.delete(extensionNumber); },
    sessionFenceMatches: (body: Record<string, unknown>) => Boolean(
      currentLease &&
      body.extension === currentLease.extension &&
      body.leaseId === currentLease.leaseId &&
      body.assignmentGeneration === currentLease.assignmentGeneration &&
      body.leaderEpoch === currentLease.leaderEpoch &&
      body.leaseVersion === currentLease.leaseVersion &&
      typeof body.browserInstanceId === "string",
    ),
    commandFenceMatches: (body: Record<string, unknown>) => Boolean(
      currentLease &&
      body.fromExtension === currentLease.extension &&
      body.leaseId === currentLease.leaseId &&
      body.assignmentGeneration === currentLease.assignmentGeneration &&
      body.leaderEpoch === currentLease.leaderEpoch &&
      body.leaseVersion === currentLease.leaseVersion &&
      typeof body.browserInstanceId === "string"
    ),
    snapshot,
    webphoneConfig: () => ({
      ok: true,
      identity: {
        defaultExtension: actorExtension ?? "",
        extensions: actorExtension ? [{ extension: actorExtension, registered: actorRegistered }] : [],
      },
      config: {
        enabled: true,
        mockEnabled: true,
        status: "ready",
        dialMode: "sip_invite",
        credentialsExposure: "browser_test",
        browserRegistrationAllowed: true,
        allowedOrigins: ["http://127.0.0.1:3000"],
        codecs: ["opus"],
        iceServers: [],
        extensions: actorExtension ? [{
          extension: actorExtension,
          label: `Pracovné miesto ${Number(actorExtension) - 19}`,
          passwordConfigured: true,
          canCallExternal: true,
          registrationEnabled: true,
        }] : [],
        missingFields: [],
      },
    }),
  };
}

function makeLease(
  extensionNumber: ExtensionNumber,
  version: number,
  sequence = 1,
  expired = false,
) {
  return {
    seatId: `seat-${extensionNumber}`,
    extension: extensionNumber,
    leaseId: `00000000-0000-4000-${String(8_000 + sequence).padStart(4, "0")}-${extensionNumber.padStart(12, "0")}`,
    assignmentGeneration: `00000000-0000-4000-9000-${String(version).padStart(12, "0")}`,
    expiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)).toISOString(),
    heartbeatIntervalMs: 15_000,
    leaderEpoch: version,
    leaseVersion: version,
  };
}

function extension(number: string, profileId: string | undefined, displayName: string, registered = false) {
  return {
    id: `ext-${number}`,
    profileId,
    extension: number,
    active: true,
    assignmentEligible: true,
    assignmentRequirement: "workplace_claim",
    displayName,
    callForwarding: "",
    registered,
    allowedChanges: ["profile_id"],
    lastSyncedAt: freshTime(),
  };
}

function queueStatus(queue: string, extensionNumber?: string, paused = false) {
  return {
    queue,
    waitingCalls: 0,
    members: extensionNumber
      ? [{ extension: extensionNumber, paused, inUse: false, dynamic: true, callsTaken: 0 }]
      : [],
  };
}

async function openWorkplace(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Linka pomoci motoristom", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 });
  await page.getByRole("button", { name: "Ústredňa", exact: true }).click();
  await page.getByRole("tab", { name: "Pracovisko", exact: true }).click();
  await expect(page.getByRole("region", { name: "Pracoviská a hovory", exact: true })).toBeVisible();
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
}

function collectConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectNoDocumentOverflow(page: Page, context: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${context} nesmie mať horizontálny overflow`).toBeLessThanOrEqual(1);
}

function isExtension(value: unknown): value is ExtensionNumber {
  return typeof value === "string" && workplaceExtensions.includes(value as ExtensionNumber);
}

function isQueue(value: unknown): value is QueueNumber {
  return value === "601" || value === "602" || value === "603";
}

function freshTime() {
  return new Date().toISOString();
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
