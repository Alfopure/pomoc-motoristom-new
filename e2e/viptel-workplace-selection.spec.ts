import { expect, test, type Page, type Route } from "@playwright/test";

test.describe("samoobslužný výber pracoviska", () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), "Mutačné UI scenáre sa spúšťajú iba lokálne s úplne stubovaným API.");

  test("operátor si klávesnicou vyberie voľné miesto s automatickou prioritou", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page);
    const consoleErrors = collectConsoleErrors(page);

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    await page.waitForTimeout(150);
    expect(api.webphoneSessionPosts, "bez vybraného pracovného miesta nesmie vzniknúť SIP session").toBe(0);

    const chooseSeat = page.getByRole("button", {
      name: "Vybrať pracovné miesto 1, interná linka 20",
      exact: true,
    });
    await chooseSeat.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("dialog")).toHaveCount(0);

    await expect.poll(() => api.patchBodies.length).toBe(2);
    expect(api.patchBodies).toEqual([
      { action: "claim_seat", extension: "20" },
      { action: "claim_priority", queue: "601" },
    ]);
    expect(api.priorityClaimsBeforeRegistration).toBe(0);
    for (const body of api.patchBodies) {
      expect(body).not.toHaveProperty("profileId");
      expect(body).not.toHaveProperty("organizationId");
    }

    await expect(page.getByText("Príjem hovorov treba skontrolovať", { exact: true })).toHaveCount(0);
    await expect.poll(() => api.webphoneSessionPosts).toBe(1);
    await expect(page.getByRole("button", {
      name: "Používaš pracovné miesto 1, interná linka 20",
      exact: true,
    })).toBeDisabled();
    await expect(page.getByText("Moje miesto", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoDocumentOverflow(page, "výber pracoviska na mobile");
    const box = await page.getByRole("button", {
      name: "Používaš pracovné miesto 1, interná linka 20",
      exact: true,
    }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    expect(api.unexpectedRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("konflikt po kliknutí neukradne miesto a nespustí výber priority", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, { failClaimSeatOnce: true });
    const consoleErrors = collectConsoleErrors(page);

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 1, interná linka 20",
      exact: true,
    }).click();

    const conflictAlert = workplaceRegion(page).getByRole("alert");
    await expect(conflictAlert).toContainText("Miesto medzitým obsadil iný operátor.");
    await expect(conflictAlert).toBeFocused();
    await expect.poll(() => api.patchBodies.length).toBe(1);
    expect(api.patchBodies).toEqual([{ action: "claim_seat", extension: "20" }]);
    await expect(page.getByRole("button", {
      name: "Pracovné miesto 1, interná linka 20, je obsadené",
      exact: true,
    })).toBeDisabled();
    await expect(page.getByText("Moje miesto", { exact: true })).toHaveCount(0);

    expect(api.unexpectedRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("výber pracoviska automaticky použije najbližšie dostupné poradie", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page);

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 1, interná linka 20",
      exact: true,
    }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect.poll(() => api.patchBodies).toEqual([
      { action: "claim_seat", extension: "20" },
      { action: "claim_priority", queue: "601" },
    ]);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("operátor už v poradí nevidí ručné prehadzovanie cudzej priority", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, { actorStartsAssigned: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    await expect(page.getByRole("button", {
      name: "Používaš pracovné miesto 1, interná linka 20",
      exact: true,
    })).toBeDisabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0);

    expect(api.patchBodies).toEqual([]);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("zlyhaná priorita ponechá úspešne získané miesto a oznámi čiastočný výsledok", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, { failPriorityOnce: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 1, interná linka 20",
      exact: true,
    }).click();

    const priorityAlert = workplaceRegion(page).getByRole("alert");
    await expect(priorityAlert).toContainText("Miesto zostalo pridelené, ale poradie sa nepodarilo uložiť.");
    await expect(priorityAlert).toBeFocused();
    await expect.poll(() => api.patchBodies.length).toBe(2);
    expect(api.patchBodies).toEqual([
      { action: "claim_seat", extension: "20" },
      { action: "claim_priority", queue: "601" },
    ]);
    await expect(page.getByRole("button", {
      name: "Obnoviť pracovné miesto 1, interná linka 20",
      exact: true,
    })).toBeEnabled();
    await expect(page.getByText("Moje miesto", { exact: true })).toBeVisible();

    expect(api.unexpectedRequests).toEqual([]);
  });

  test("čiastočne zlyhané uvoľnenie ponechá miesto vlastnené, ale mimo poradia", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, {
      actorStartsAssigned: true,
      failReleaseSeatOnce: true,
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    await expect.poll(() => api.providerPresencePosts).toBe(1);
    await page.getByRole("button", { name: "Uvoľniť pracovné miesto", exact: true }).click();

    const releaseAlert = workplaceRegion(page).getByRole("alert");
    await expect(releaseAlert).toContainText("Poradie bolo uvoľnené, pracovné miesto však zostalo pridelené.");
    await expect(releaseAlert).toBeFocused();
    await expect.poll(() => api.patchBodies.length).toBe(2);
    expect(api.patchBodies).toEqual([
      { action: "release_priority" },
      { action: "release_seat" },
    ]);
    await expect(page.getByRole("button", {
      name: "Obnoviť pracovné miesto 1, interná linka 20",
      exact: true,
    })).toBeEnabled();
    await expect(page.locator('[data-workplace-station="20"]').getByText("Mimo poradia", { exact: true })).toBeVisible();

    expect(api.unexpectedRequests).toEqual([]);
  });

  test("provider chyba pri uvoľnení priority zastaví release sedadla", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, {
      actorStartsAssigned: true,
      failReleasePriorityOnce: true,
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    await page.getByRole("button", { name: "Uvoľniť pracovné miesto", exact: true }).click();

    const providerAlert = workplaceRegion(page).getByRole("alert");
    await expect(providerAlert).toContainText("VIPTel nepotvrdil odstránenie priority.");
    await expect(providerAlert).toBeFocused();
    await expect.poll(() => api.patchBodies.length).toBe(1);
    expect(api.patchBodies).toEqual([{ action: "release_priority" }]);
    await expect(page.getByRole("button", {
      name: "Používaš pracovné miesto 1, interná linka 20",
      exact: true,
    })).toBeDisabled();
    await expect(page.locator('[data-workplace-station="20"]').getByText("1. v poradí", { exact: true })).toBeVisible();

    expect(api.unexpectedRequests).toEqual([]);
  });

  test("chybu prvého načítania vie operátor obnoviť klávesnicou", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, { failWorkplaceReadOnce: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkplace(page);

    const refresh = page.getByRole("button", { name: "Obnoviť dostupnosť", exact: true });
    await expect(refresh).toBeVisible();
    await refresh.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("button", {
      name: "Vybrať pracovné miesto 1, interná linka 20",
      exact: true,
    })).toBeEnabled();
    await expect(refresh).toHaveCount(0);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("202 pri uvoľnení priority nepokračuje na uvoľnenie miesta ani ďalší provider refresh", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, {
      actorStartsAssigned: true,
      releasePriorityStaysActivating: true,
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    await expect.poll(() => api.providerPresencePosts).toBe(1);
    await page.getByRole("button", { name: "Uvoľniť pracovné miesto", exact: true }).click();

    await expect(page.getByText("VIPTel zmenu stále aktivuje.", { exact: true })).toBeVisible({ timeout: 10_000 });
    expect(api.patchBodies).toEqual([{ action: "release_priority" }]);
    expect(api.providerPresencePosts).toBe(1);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("202 pri prepnutí miesta zastaví claim, odpojenie webphone aj ďalší provider refresh", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, {
      actorStartsAssigned: true,
      releasePriorityStaysActivating: true,
      seat23Available: true,
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    await expect.poll(() => api.providerPresencePosts).toBe(1);
    await page.getByRole("button", {
      name: "Vybrať pracovné miesto 4, interná linka 23",
      exact: true,
    }).click();

    await expect(page.getByText("VIPTel zmenu stále aktivuje.", { exact: true })).toBeVisible({ timeout: 10_000 });
    expect(api.patchBodies).toEqual([{ action: "release_priority" }]);
    expect(api.providerPresencePosts).toBe(1);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("už uložený prvý výber sa po opätovnom potvrdení odošle do VIPTel", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, { retryablePriorityDraft: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    const recover = page.getByRole("button", {
      name: "Obnoviť pracovné miesto 1, interná linka 20",
      exact: true,
    });
    await expect(recover).toBeEnabled();
    await recover.click();

    await expect.poll(() => api.patchBodies).toEqual([{ action: "claim_priority", queue: "601" }]);
    await expect(page.getByText("Príjem hovorov treba skontrolovať", { exact: true })).toHaveCount(0);
    await expect.poll(() => api.providerPresencePosts).toBeGreaterThanOrEqual(1);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("krátky výpadok aktívnych hovorov nezneplatní overené poradie operátora", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, {
      actorStartsAssigned: true,
      failActiveCallsOnce: true,
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);

    await expect(page.getByText("Príjem hovorov treba skontrolovať", { exact: true })).toHaveCount(0);
    expect(api.activeCallsReads).toBeGreaterThanOrEqual(1);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("admin klávesnicou prevezme odpojené miesto a zachová jeho druhú prioritu", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, { seat21Management: "allowed" });
    const consoleErrors = collectConsoleErrors(page);

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    await expect.poll(() => api.workplaceReads).toBeGreaterThanOrEqual(1);
    await expect.poll(() => api.webphoneConfigReads).toBeGreaterThanOrEqual(1);
    expect(api.webphoneSessionPosts, "admin bez miesta ešte nesmie vytvoriť SIP session").toBe(0);

    const requestsBeforeTakeover = {
      config: api.webphoneConfigReads,
      presence: api.providerPresencePosts,
      workplace: api.workplaceReads,
    };
    const takeover = page.getByRole("button", {
      name: "Prevziať pracovné miesto 2, interná linka 21, od operátora Mango Mango",
      exact: true,
    });
    await expect(page.locator('[data-workplace-station="21"]').getByRole("button", {
      name: "Uvoľniť pracovné miesto",
      exact: true,
    })).toHaveCount(0);
    await takeover.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("alertdialog", { name: "Prevziať pracovné miesto?", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Mango Mango", { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText("2. v poradí zostane nezmenené", { exact: true })).toBeVisible();
    const cancel = dialog.getByRole("button", { name: "Ponechať bez zmeny", exact: true });
    const confirm = dialog.getByRole("button", { name: "Áno, prevziať miesto", exact: true });
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(dialog).toHaveCount(0);
    await expect.poll(() => api.patchBodies).toEqual([
      { action: "takeover_seat", extension: "21" },
    ]);
    expect(api.patchBodies[0]).not.toHaveProperty("profileId");
    expect(api.patchBodies[0]).not.toHaveProperty("organizationId");
    await expect(page.locator('[data-workplace-station="21"]').getByText("Moje miesto", { exact: true })).toBeVisible();
    await expect(page.locator('[data-workplace-station="21"]').getByText("2. v poradí", { exact: true })).toBeVisible();

    const confirmedMessage = "Pracovné miesto 21 je prevzaté a zostáva v priorite 2. Pripojenie telefónu potvrdil aj VIPTel.";
    const feedback = workplaceRegion(page).getByRole("status").filter({ hasText: confirmedMessage });
    await expect(feedback).toBeVisible();
    await expect(feedback).toHaveText(confirmedMessage);
    await expect(feedback).toBeFocused();
    await expect.poll(() => api.workplaceReads).toBeGreaterThan(requestsBeforeTakeover.workplace);
    await expect.poll(() => api.providerPresencePosts).toBeGreaterThan(requestsBeforeTakeover.presence);
    await expect.poll(() => api.webphoneConfigReads).toBeGreaterThan(requestsBeforeTakeover.config);
    await expect.poll(() => api.webphoneSessionPosts).toBe(1);
    await expect(page.locator('[data-workplace-station="21"]').getByText("Pripravený", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoDocumentOverflow(page, "prevzatie pracovného miesta na mobile");
    const mineButton = page.getByRole("button", {
      name: "Používaš pracovné miesto 2, interná linka 21",
      exact: true,
    });
    const mineButtonBox = await mineButton.boundingBox();
    expect(mineButtonBox?.height ?? 0, "ovládanie prevzatého miesta musí mať dotykovú výšku aspoň 44 px").toBeGreaterThanOrEqual(44);

    expect(api.unexpectedRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("zlyhané pripojenie po prevzatí ponechá miesto adminovi bez opakovania takeover mutácie", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, {
      seat21Management: "allowed",
      webphoneMockEnabled: false,
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    await page.getByRole("button", {
      name: "Prevziať pracovné miesto 2, interná linka 21, od operátora Mango Mango",
      exact: true,
    }).click();
    const dialog = page.getByRole("alertdialog", { name: "Prevziať pracovné miesto?", exact: true });
    await dialog.getByRole("button", { name: "Áno, prevziať miesto", exact: true }).click();

    await expect(dialog).toHaveCount(0);
    const warning = workplaceRegion(page).getByRole("status").filter({
      hasText: "Pracovné miesto 21 je prevzaté, ale telefón sa nepripojil.",
    });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Prehliadač telefón nepripojil.");
    await expect(warning).toContainText("pracovné miesto už nepreberaj opakovane.");
    await expect(warning).toBeFocused();
    await expect(page.locator('[data-workplace-station="21"]').getByText("Moje miesto", { exact: true })).toBeVisible();

    await expect.poll(() => api.patchBodies).toEqual([
      { action: "takeover_seat", extension: "21" },
    ]);
    await expect.poll(() => api.webphoneSessionPosts).toBe(1);
    await page.waitForTimeout(1_000);
    expect(api.patchBodies, "zlyhanie telefónu nesmie zopakovať už potvrdené prevzatie").toEqual([
      { action: "takeover_seat", extension: "21" },
    ]);
    expect(api.webphoneSessionPosts, "zlyhanie nesmie spustiť automatickú session retry slučku").toBe(1);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("admin uvoľní odpojené obsadené miesto iba mimo poradia", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, { seat21Management: "release_allowed" });

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    const station = page.locator('[data-workplace-station="21"]');
    await expect(station.getByText("Mimo poradia", { exact: true })).toBeVisible();
    const release = station.getByRole("button", { name: "Uvoľniť pracovné miesto", exact: true });
    await expect(release).toBeEnabled();
    await release.click();

    const dialog = page.getByRole("alertdialog", { name: "Uvoľniť pracovné miesto?", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Mimo poradia zvonenia", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Áno, uvoľniť miesto", exact: true }).click();

    await expect(dialog).toHaveCount(0);
    await expect.poll(() => api.patchBodies).toEqual([
      { action: "release_occupied_seat", extension: "21" },
    ]);
    expect(api.patchBodies[0]).not.toHaveProperty("profileId");
    await expect(page.getByRole("button", {
      name: "Vybrať pracovné miesto 2, interná linka 21",
      exact: true,
    })).toBeEnabled();
    await expect(station.getByText("Moje miesto", { exact: true })).toHaveCount(0);
    expect(api.webphoneSessionPosts, "uvoľnenie cudzieho miesta nesmie pripojiť webphone admina").toBe(0);
    expect(api.unexpectedRequests).toEqual([]);
  });

  for (const blocked of [
    {
      management: "blocked_registered" as const,
      reason: "Telefón je stále pripojený vo VIPTel.",
      title: "registrované",
    },
    {
      management: "blocked_unknown" as const,
      reason: "Živý stav telefónu nie je potvrdený. Obnov stav.",
      title: "neoverené",
    },
  ]) {
    test(`admin neprevezme ${blocked.title} miesto a môže obnoviť jeho stav`, async ({ page }) => {
      const api = await installWorkplaceApiFirewall(page, { seat21Management: blocked.management });

      await page.setViewportSize({ width: 390, height: 844 });
      await openWorkplace(page);

      const station = page.locator('[data-workplace-station="21"]');
      await expect(station.getByText(blocked.reason, { exact: true })).toBeVisible();
      const blockedTakeover = page.getByRole("button", {
        name: "Pracovné miesto 2, interná linka 21, je obsadené",
        exact: true,
      });
      await expect(blockedTakeover).toBeDisabled();
      await expect(blockedTakeover).toHaveAttribute("aria-describedby", "workplace-management-reason-21");

      const readsBeforeRefresh = api.workplaceReads;
      const refresh = station.getByRole("button", { name: "Obnoviť stav", exact: true });
      await refresh.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => api.workplaceReads).toBeGreaterThan(readsBeforeRefresh);
      expect(api.patchBodies, "obnova ani blokované prevzatie nesmú odoslať mutáciu").toEqual([]);
      await expectNoDocumentOverflow(page, `blokované ${blocked.title} miesto na mobile`);
      expect(api.unexpectedRequests).toEqual([]);
    });
  }

  test("operátor prepne pracovný stav Dostupný, Pauza, Mimo radu a späť", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, { actorStartsAssigned: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);
    const statusPanel = page.getByRole("region", { name: "Môj stav operátora", exact: true });
    await expect(statusPanel.getByText("Dostupný", { exact: true }).first()).toBeVisible();

    await statusPanel.getByRole("button", { name: "Pauza", exact: true }).click();
    await expect(page.getByText("Stav je Pauza.", { exact: true })).toBeVisible();
    await expect(statusPanel.getByText("Pauza", { exact: true }).first()).toBeVisible();

    await statusPanel.getByRole("button", { name: "Mimo radu", exact: true }).click();
    await expect(page.getByText("Stav je Offline.", { exact: true })).toBeVisible();
    await expect(statusPanel.getByRole("button", { name: "Mimo radu", exact: true })).toHaveAttribute("aria-pressed", "true");

    await statusPanel.getByRole("button", { name: "Dostupný", exact: true }).click();
    await expect(page.getByText("Stav je Dostupný.", { exact: true })).toBeVisible();
    await expect(statusPanel.getByRole("button", { name: "Dostupný", exact: true })).toHaveAttribute("aria-pressed", "true");

    expect(api.availabilityBodies).toEqual([
      { action: "pause", extension: "20" },
      { action: "offline", extension: "20" },
      { action: "available", extension: "20" },
    ]);
    expect(api.unexpectedRequests).toEqual([]);
  });

  test("vybrané pracovisko pripojí webphone automaticky iba raz a po chybe dovolí bezpečné opakovanie", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, {
      actorStartsAssigned: true,
      holdFirstWebphoneSession: true,
      webphoneMockEnabled: false,
      webphoneSessionFailures: [
        { status: 409, error: "Interná linka 20 momentálne nie je vo VIPTel aktívna." },
        { status: 502, error: "Telefónna ústredňa VIPTel je dočasne nedostupná." },
      ],
    });
    const consoleErrors = collectConsoleErrors(page);

    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkplace(page);

    await expect.poll(() => api.webphoneSessionPosts).toBe(1);
    await expect(page.getByText("Pripájam…", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Pripojiť", exact: true })).toHaveCount(0);
    await page.waitForTimeout(150);
    expect(api.webphoneSessionPosts, "polling ani opakované rendery nesmú vytvoriť druhý pokus").toBe(1);

    api.releaseFirstWebphoneSession();
    const notice = page.locator("#browser-phone-notice");
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(notice).toContainText("Interná linka 20 momentálne nie je vo VIPTel aktívna.");
    await expect(notice).toContainText("Skús pripojenie znova.");
    await expect(page.getByText("Pripojenie zlyhalo", { exact: true })).toBeVisible();
    await page.waitForTimeout(3_500);
    expect(api.webphoneSessionPosts, "chyba nesmie spustiť automatickú retry slučku").toBe(1);

    const retry = page.getByRole("button", { name: "Skúsiť znova", exact: true });
    await expect(retry).toHaveAttribute("aria-describedby", "browser-phone-notice");
    await retry.click();
    await expect.poll(() => api.webphoneSessionPosts).toBe(2);
    await expect(notice).toContainText("Telefónna ústredňa VIPTel je dočasne nedostupná.");
    await expect(notice).toContainText("Ak problém pretrváva, obnov Pracovisko.");

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoDocumentOverflow(page, "chyba pripojenia webphone na mobile");
    const retryBox = await retry.boundingBox();
    expect(retryBox?.height ?? 0, "opakovaný pokus musí mať dotykovú výšku aspoň 44 px").toBeGreaterThanOrEqual(44);

    expect(api.unexpectedRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("webphone zobrazí bezpečnú chybu aj po zlyhaní SIP spojenia", async ({ page }) => {
    const api = await installWorkplaceApiFirewall(page, {
      actorStartsAssigned: true,
      webphoneMockEnabled: false,
      webphoneSessionSucceeds: true,
    });

    await openWorkplace(page);

    const notice = page.locator("#browser-phone-notice");
    await expect(notice).toHaveAttribute("role", "alert", { timeout: 15_000 });
    await expect(notice).toContainText("Spojenie s telefónnou ústredňou VIPTel sa nepodarilo.");
    await expect(notice).toContainText("Skús pripojenie znova.");
    await expect(notice).not.toContainText("127.0.0.1");
    await expect(page.getByRole("button", { name: "Skúsiť znova", exact: true })).toBeVisible();
    await page.waitForTimeout(150);
    expect(api.webphoneSessionPosts).toBe(1);
    expect(api.unexpectedRequests).toEqual([]);
  });
});

type WebphoneSessionFailure = {
  error: string;
  status: 409 | 502;
};

type WorkplaceApiOptions = {
  actorStartsAssigned?: boolean;
  failActiveCallsOnce?: boolean;
  failClaimSeatOnce?: boolean;
  failPriorityOnce?: boolean;
  failReleasePriorityOnce?: boolean;
  failReleaseSeatOnce?: boolean;
  failWorkplaceReadOnce?: boolean;
  holdFirstWebphoneSession?: boolean;
  releasePriorityStaysActivating?: boolean;
  retryablePriorityDraft?: boolean;
  seat21Management?: "allowed" | "blocked_registered" | "blocked_unknown" | "release_allowed";
  seat23Available?: boolean;
  webphoneSessionFailures?: WebphoneSessionFailure[];
  webphoneMockEnabled?: boolean;
  webphoneSessionSucceeds?: boolean;
};

async function installWorkplaceApiFirewall(page: Page, options: WorkplaceApiOptions = {}) {
  const patchBodies: Array<Record<string, unknown>> = [];
  const availabilityBodies: Array<Record<string, unknown>> = [];
  const unexpectedRequests: string[] = [];
  const state = workplaceState(
    Boolean(options.actorStartsAssigned),
    Boolean(options.seat23Available),
    Boolean(options.retryablePriorityDraft),
    options.webphoneMockEnabled !== false,
    options.seat21Management,
  );
  let failClaimSeatOnce = Boolean(options.failClaimSeatOnce);
  let failPriorityOnce = Boolean(options.failPriorityOnce);
  let failReleasePriorityOnce = Boolean(options.failReleasePriorityOnce);
  let failReleaseSeatOnce = Boolean(options.failReleaseSeatOnce);
  let failWorkplaceReadOnce = Boolean(options.failWorkplaceReadOnce);
  let failActiveCallsOnce = Boolean(options.failActiveCallsOnce);
  let activeCallsReads = 0;
  let providerPresencePosts = 0;
  let webphoneConfigReads = 0;
  let priorityClaimsBeforeRegistration = 0;
  let workplaceReads = 0;
  let webphoneSessionPosts = 0;
  let releaseFirstWebphoneSession: () => void = () => undefined;
  const firstWebphoneSessionGate = options.holdFirstWebphoneSession
    ? new Promise<void>((resolve) => { releaseFirstWebphoneSession = resolve; })
    : Promise.resolve();
  const webphoneSessionFailures = options.webphoneSessionFailures ?? [{
    status: 409,
    error: "Izolovaný QA mock nevydáva SIP session.",
  } satisfies WebphoneSessionFailure];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/workplace-takeover" && method === "GET") {
      return fulfillJson(route, { ok: true, takeover: { checkedAt: new Date().toISOString() } });
    }

    if (url.pathname === "/api/telephony/workplace-selection" && method === "GET") {
      workplaceReads += 1;
      if (failWorkplaceReadOnce) {
        failWorkplaceReadOnce = false;
        return fulfillJson(route, { ok: false, error: "Dostupnosť pracovných miest sa nepodarilo načítať." }, 503);
      }
      return fulfillJson(route, { ok: true, workplace: state.snapshot() });
    }
    if (url.pathname === "/api/telephony/workplace-selection" && method === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      patchBodies.push(body);

      if (body.action === "claim_seat" && body.extension === "20") {
        if (failClaimSeatOnce) {
          failClaimSeatOnce = false;
          state.occupySeat20ByAnotherOperator();
          return fulfillJson(route, { ok: false, error: "Miesto medzitým obsadil iný operátor." }, 409);
        }
        state.claimSeat20();
        return fulfillJson(route, {
          ok: true,
          result: { state: "confirmed", message: "Pracovné miesto 1 je pridelené." },
          workplace: state.snapshot(),
        });
      }

      if (body.action === "takeover_seat" && body.extension === "21" && options.seat21Management === "allowed") {
        state.takeoverSeat21();
        return fulfillJson(route, {
          ok: true,
          result: {
            state: "confirmed",
            message: "Pracovné miesto 21 je prevzaté a zostáva v priorite 2.",
          },
          workplace: state.snapshot(),
        });
      }

      if (body.action === "release_occupied_seat" && body.extension === "21" && options.seat21Management === "release_allowed") {
        state.releaseSeat21();
        return fulfillJson(route, {
          ok: true,
          result: {
            state: "confirmed",
            message: "Pracovné miesto 21 je uvoľnené.",
          },
          workplace: state.snapshot(),
        });
      }

      if (body.action === "claim_priority" && body.queue === "601") {
        if (!state.isWebphone20Registered()) {
          priorityClaimsBeforeRegistration += 1;
          return fulfillJson(route, {
            ok: false,
            error: "Interná linka 20 ešte nie je registrovaná.",
          }, 409);
        }
        if (failPriorityOnce) {
          failPriorityOnce = false;
          return fulfillJson(route, {
            ok: false,
            error: "Miesto zostalo pridelené, ale poradie sa nepodarilo uložiť.",
          }, 409);
        }
        state.claimPriority601();
        return fulfillJson(route, {
          ok: true,
          result: { state: "confirmed", message: "Prvé poradie zvonenia je uložené." },
          workplace: state.snapshot(),
        });
      }

      if (body.action === "release_priority") {
        if (failReleasePriorityOnce) {
          failReleasePriorityOnce = false;
          return fulfillJson(route, {
            ok: false,
            error: "VIPTel nepotvrdil odstránenie priority.",
          }, 502);
        }
        if (options.releasePriorityStaysActivating) {
          state.startStuckPriorityRelease();
          return fulfillJson(route, {
            ok: true,
            result: { state: "pending", message: "VIPTel zmenu stále aktivuje." },
            workplace: state.snapshot(),
          }, 202);
        }
        state.releasePriority601();
        return fulfillJson(route, {
          ok: true,
          result: { state: "confirmed", message: "Poradie zvonenia je uvoľnené." },
          workplace: state.snapshot(),
        });
      }

      if (body.action === "release_seat") {
        if (failReleaseSeatOnce) {
          failReleaseSeatOnce = false;
          return fulfillJson(route, {
            ok: false,
            error: "Poradie bolo uvoľnené, pracovné miesto však zostalo pridelené.",
          }, 503);
        }
        state.releaseSeat20();
        return fulfillJson(route, {
          ok: true,
          result: { state: "confirmed", message: "Pracovné miesto je uvoľnené." },
          workplace: state.snapshot(),
        });
      }

      unexpectedRequests.push(`${method} ${url.pathname} ${JSON.stringify(body)}`);
      return fulfillJson(route, { error: "QA zablokovalo neočakávanú mutáciu pracoviska." }, 599);
    }

    if (url.pathname === "/api/telephony/presence" && (method === "GET" || method === "POST")) {
      if (method === "POST") {
        providerPresencePosts += 1;
        state.confirmProviderRefresh();
      }
      return fulfillJson(route, {
        ok: true,
        source: method === "POST" ? "provider_refresh" : "stored",
        actorRouting: state.actorQueue()
          ? { queue: state.actorQueue(), revision: 7 }
          : null,
        routingDiagnostic: state.actorQueue() ? null : "Prihlásený operátor ešte nie je v poradí 601–603.",
        snapshot: state.presence(),
      });
    }
    if (url.pathname === "/api/telephony/webphone/config" && method === "GET") {
      webphoneConfigReads += 1;
      return fulfillJson(route, state.webphoneConfig());
    }
    if (url.pathname === "/api/telephony/webphone/session" && method === "POST") {
      webphoneSessionPosts += 1;
      if (webphoneSessionPosts === 1) {
        await firstWebphoneSessionGate;
      }
      if (options.webphoneSessionSucceeds) {
        return fulfillJson(route, successfulUnreachableWebphoneSession());
      }
      if (options.webphoneMockEnabled !== false) state.registerActorWebphone();
      const failure = webphoneSessionFailures[Math.min(webphoneSessionPosts - 1, webphoneSessionFailures.length - 1)];
      return fulfillJson(route, { ok: false, error: failure.error }, failure.status);
    }
    if (url.pathname === "/api/telephony/queues/agent" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      availabilityBodies.push(body);
      state.prepareAvailability(body.action);
      return fulfillJson(route, {
        ok: true,
        queue: "601",
        routingRevision: 7,
        command: { id: `availability-${availabilityBodies.length}`, status: "queued" },
      });
    }
    if (url.pathname.startsWith("/api/telephony/commands/availability-") && method === "GET") {
      state.confirmAvailability();
      return fulfillJson(route, {
        ok: true,
        command: {
          id: url.pathname.split("/").at(-1),
          status: "confirmed_by_event",
        },
      });
    }
    if (url.pathname === "/api/telephony/calls/active" && method === "GET") {
      activeCallsReads += 1;
      if (failActiveCallsOnce) {
        failActiveCallsOnce = false;
        return fulfillJson(route, { ok: false, error: "Dočasný výpadok zoznamu aktívnych hovorov." }, 504);
      }
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

    unexpectedRequests.push(`${method} ${url.pathname}`);
    return fulfillJson(route, { error: "QA API firewall zablokoval neočakávanú požiadavku." }, 599);
  });

  return {
    availabilityBodies,
    patchBodies,
    unexpectedRequests,
    get activeCallsReads() {
      return activeCallsReads;
    },
    get providerPresencePosts() {
      return providerPresencePosts;
    },
    get priorityClaimsBeforeRegistration() {
      return priorityClaimsBeforeRegistration;
    },
    releaseFirstWebphoneSession,
    get webphoneSessionPosts() {
      return webphoneSessionPosts;
    },
    get webphoneConfigReads() {
      return webphoneConfigReads;
    },
    get workplaceReads() {
      return workplaceReads;
    },
  };
}

function successfulUnreachableWebphoneSession() {
  return {
    ok: true,
    session: {
      dialMode: "sip_invite",
      credentialsExposure: "browser_test",
      sipWebSocketUrl: "ws://127.0.0.1:1",
      sipDomain: "sip.invalid.test",
      sipRealm: "sip.invalid.test",
      browserRegistrationAllowed: true,
      allowedOrigins: ["http://127.0.0.1:3000"],
      codecs: ["opus"],
      dtmfMode: "rfc2833",
      iceServers: [],
      extension: {
        extension: "20",
        label: "Pracovné miesto 1",
        authUsername: "20",
        password: "isolated-e2e-password",
        passwordConfigured: true,
        canCallExternal: true,
        registrationEnabled: true,
      },
    },
  };
}

function workplaceState(
  actorStartsAssigned: boolean,
  seat23Available = false,
  retryablePriorityDraft = false,
  webphoneMockEnabled = true,
  seat21Management?: "allowed" | "blocked_registered" | "blocked_unknown" | "release_allowed",
) {
  let seat20: "actor" | "available" | "other" = actorStartsAssigned || retryablePriorityDraft ? "actor" : "available";
  let actorPriority601 = actorStartsAssigned || retryablePriorityDraft;
  let activePriority601 = actorStartsAssigned;
  let routingActivating = false;
  let availability: "available" | "offline" | "pause" = "available";
  let pendingAvailability: "available" | "offline" | "pause" | null = null;
  let webphone20Registered = actorStartsAssigned;
  let seat21: "actor" | "available" | "other" = "other";
  let webphone21Registered = false;
  let disconnectPending = false;

  return {
    actorQueue: () => activePriority601 && seat20 === "actor"
      ? "601" as const
      : seat21 === "actor"
        ? "602" as const
        : null,
    claimPriority601: () => {
      actorPriority601 = true;
      activePriority601 = true;
    },
    claimSeat20: () => { seat20 = "actor"; },
    isWebphone20Registered: () => webphone20Registered,
    registerActorWebphone: () => {
      if (seat20 === "actor") webphone20Registered = true;
      if (seat21 === "actor") webphone21Registered = true;
    },
    takeoverSeat21: () => {
      seat21 = "actor";
      webphone21Registered = false;
    },
    releaseSeat21: () => {
      seat21 = "available";
      webphone21Registered = false;
    },
    occupySeat20ByAnotherOperator: () => { seat20 = "other"; },
    prepareAvailability: (action: unknown) => {
      if (action === "available" || action === "offline" || action === "pause") {
        pendingAvailability = action;
      }
    },
    confirmAvailability: () => {
      if (pendingAvailability) availability = pendingAvailability;
      pendingAvailability = null;
    },
    confirmProviderRefresh: () => {
      if (!disconnectPending) return;
      webphone20Registered = false;
      disconnectPending = false;
    },
    releasePriority601: () => {
      actorPriority601 = false;
      activePriority601 = false;
      disconnectPending = true;
    },
    startStuckPriorityRelease: () => {
      actorPriority601 = false;
      routingActivating = true;
    },
    releaseSeat20: () => { seat20 = "available"; },
    presence: () => {
      const checkedAt = freshTime();
      return {
        actorProfileId: "op-natalia",
        canManageAssignments: Boolean(seat21Management),
        checkedAt,
        extensions: [
          extension("20", seat20 === "actor" ? "op-natalia" : seat20 === "other" ? "op-mango" : undefined, seat20 === "actor" ? "Natália" : seat20 === "other" ? "Mango Mango" : "Pracovné miesto 1", webphone20Registered && seat20 === "actor"),
          extension(
            "21",
            seat21 === "actor" ? "op-natalia" : seat21 === "other" ? "op-mango" : undefined,
            seat21 === "actor" ? "Natália" : seat21 === "other" ? "Mango Mango" : "Pracovné miesto 2",
            seat21 === "actor"
              ? webphone21Registered
              : seat21Management === "allowed" || seat21Management === "release_allowed"
                ? false
                : seat21Management === "blocked_unknown"
                  ? null
                  : true,
          ),
          extension("22", "op-miso", "Michal", true),
          extension("23", undefined, "Pracovné miesto 4"),
        ],
        queues: ["601", "602", "603"].map((queue) => ({ id: `q-${queue}`, name: queue })),
        queueStatuses: [
          queueStatus(
            "601",
            (activePriority601 || routingActivating) && seat20 === "actor" && availability !== "offline" ? "20" : undefined,
            availability === "pause",
          ),
          queueStatus(
            "602",
            seat21Management === "release_allowed" && seat21 !== "actor" ? undefined : "21",
            seat21 === "actor" && availability === "pause",
          ),
          queueStatus("603", actorStartsAssigned ? "22" : undefined),
        ],
      };
    },
    snapshot: () => ({
      checkedAt: freshTime(),
      selection: {
        extension: seat20 === "actor" ? "20" : seat21 === "actor" ? "21" : null,
        queue: actorPriority601 && seat20 === "actor" ? "601" : seat21 === "actor" ? "602" : null,
      },
      seats: [
        seat20 === "actor"
          ? { extension: "20", status: "mine", profileId: "op-natalia", profileName: "Natália", registered: false }
          : seat20 === "other"
            ? { extension: "20", status: "occupied", profileId: "op-mango", profileName: "Mango Mango", registered: true }
            : { extension: "20", status: "available", registered: false },
        seat21 === "actor"
          ? { extension: "21", status: "mine", profileId: "op-natalia", profileName: "Natália", registered: webphone21Registered }
          : seat21 === "available"
            ? { extension: "21", status: "available", registered: false }
          : {
              extension: "21",
              status: "occupied",
              profileId: "op-mango",
              profileName: "Mango Mango",
              ...(seat21Management === "blocked_unknown"
                ? {}
                : { registered: seat21Management === "allowed" || seat21Management === "release_allowed" ? false : true }),
              ...(seat21Management
                ? {
                    management: seat21Management === "allowed" || seat21Management === "release_allowed"
                      ? {
                          takeover: "allowed",
                          release: seat21Management === "release_allowed" ? "allowed" : "blocked",
                          ...(seat21Management === "allowed"
                            ? { reason: "Miesto je súčasťou poradia. Prevezmi ho, aby poradie zostalo funkčné." }
                            : {}),
                        }
                      : {
                          takeover: "blocked",
                          release: "blocked",
                          refreshable: true,
                          reason: seat21Management === "blocked_registered"
                            ? "Telefón je stále pripojený vo VIPTel."
                            : "Živý stav telefónu nie je potvrdený. Obnov stav.",
                        },
                  }
                : {}),
            },
        { extension: "22", status: "occupied", profileId: "op-miso", profileName: "Michal", registered: true },
        seat23Available
          ? { extension: "23", status: "available", registered: false }
          : { extension: "23", status: "unavailable", registered: true },
      ],
      priorities: [
        actorPriority601 && seat20 === "actor"
          ? { queue: "601", order: 1, activeExtension: activePriority601 ? "20" : null, selectedExtension: "20", status: activePriority601 ? "mine" : "pending_mine", selectionEffect: "mine" }
          : routingActivating
            ? { queue: "601", order: 1, activeExtension: "20", selectedExtension: null, status: "available", selectionEffect: "claim" }
            : { queue: "601", order: 1, activeExtension: null, selectedExtension: null, status: "available", selectionEffect: "claim" },
        seat21 === "actor"
          ? {
              queue: "602",
              order: 2,
              activeExtension: "21",
              selectedExtension: "21",
              status: "mine",
              selectionEffect: "mine",
              profileId: "op-natalia",
              profileName: "Natália",
            }
          : seat21Management === "release_allowed"
            ? {
                queue: "602",
                order: 2,
                activeExtension: null,
                selectedExtension: null,
                status: "available",
                selectionEffect: "claim",
              }
            : {
              queue: "602",
              order: 2,
              activeExtension: "21",
              selectedExtension: "21",
              status: "occupied",
              selectionEffect: actorPriority601 && seat20 === "actor" ? "swap" : "replace",
              profileId: "op-mango",
              profileName: "Mango Mango",
              willDisplace: { extension: "21", profileId: "op-mango", profileName: "Mango Mango" },
            },
        actorStartsAssigned
          ? {
              queue: "603",
              order: 3,
              activeExtension: "22",
              selectedExtension: "22",
              status: "occupied",
              selectionEffect: actorPriority601 && seat20 === "actor" ? "swap" : "replace",
              profileId: "op-miso",
              profileName: "Michal",
              willDisplace: { extension: "22", profileId: "op-miso", profileName: "Michal" },
            }
          : { queue: "603", order: 3, activeExtension: null, selectedExtension: null, status: "available", selectionEffect: "claim" },
      ],
      routingStatus: {
        state: routingActivating ? "activating" : activePriority601 || seat21 === "actor" ? "active" : actorPriority601 ? "ready" : "collecting",
        selectedCount: (actorPriority601 ? 1 : 0) + 1 + (actorStartsAssigned ? 1 : 0),
        capacityCount: 3,
        message: routingActivating
          ? "VIPTel zmenu stále aktivuje."
          : activePriority601 || seat21 === "actor"
            ? "Poradie zvonenia je aktívne."
          : actorPriority601
            ? "Výber prvého operátora je uložený a pripravený na aktiváciu."
          : "Vyber voľné pracovisko a prioritu zvonenia.",
      },
    }),
    webphoneConfig: () => {
      const actorExtension = seat20 === "actor" ? "20" : seat21 === "actor" ? "21" : null;
      const actorRegistered = actorExtension === "20" ? webphone20Registered : webphone21Registered;
      return {
        ok: true,
        identity: {
          defaultExtension: actorExtension ?? "",
          extensions: actorExtension ? [{ extension: actorExtension, registered: actorRegistered }] : [],
        },
        config: {
          enabled: true,
          mockEnabled: webphoneMockEnabled,
          status: "ready",
          dialMode: "sip_invite",
          credentialsExposure: "browser_test",
          browserRegistrationAllowed: true,
          allowedOrigins: ["http://127.0.0.1:3000"],
          codecs: ["opus"],
          iceServers: [],
          extensions: actorExtension ? [{
            extension: actorExtension,
            label: actorExtension === "20" ? "Pracovné miesto 1" : "Pracovné miesto 2",
            passwordConfigured: true,
            canCallExternal: true,
            registrationEnabled: true,
          }] : [],
          missingFields: [],
        },
      };
    },
  };
}

function extension(number: string, profileId: string | undefined, displayName: string, registered: boolean | null = false) {
  return {
    id: `ext-${number}`,
    profileId,
    extension: number,
    active: true,
    assignmentEligible: true,
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
  // See the same helper in viptel-telephony-ui.spec.ts: which data source the
  // chip names depends on this run's route firewall, so assert the chip exists
  // rather than which source it happens to report.
  await expect(page.getByText(/^Dispečing · pilotný deň · (Supabase live|Mock fallback)$/)).toBeVisible();
  await page.getByRole("button", { name: "Ústredňa", exact: true }).click();
  await page.getByRole("tab", { name: "Pracovisko", exact: true }).click();
  await expect(page.getByRole("region", { name: "Pracoviská a hovory", exact: true })).toBeVisible();
}

function workplaceRegion(page: Page) {
  return page.getByRole("region", { name: "Pracoviská a hovory", exact: true });
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
}

function collectConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectNoDocumentOverflow(page: Page, context: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${context} nesmie mať horizontálny overflow`).toBeLessThanOrEqual(1);
}

function freshTime() {
  return new Date().toISOString();
}
