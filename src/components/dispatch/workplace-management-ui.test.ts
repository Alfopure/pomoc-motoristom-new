import { describe, expect, it } from "vitest";
import {
  buildTakeoverPhoneHandshakeResult,
  getWorkplaceManagementState,
  getWorkplacePriorityUiState,
  getWorkplaceSeatUiState,
  type WorkplaceSelectionSnapshot,
} from "./WorkplaceView";

type WorkplaceSeat = WorkplaceSelectionSnapshot["seats"][number];
type WorkplacePriority = WorkplaceSelectionSnapshot["priorities"][number];

function seat(overrides: Partial<WorkplaceSeat> = {}): WorkplaceSeat {
  return {
    extension: "21",
    profileId: "operator-mango",
    profileName: "Mango Mango",
    registered: false,
    status: "occupied",
    ...overrides,
  };
}

function priority(overrides: Partial<WorkplacePriority> = {}): WorkplacePriority {
  return {
    activeExtension: null,
    order: 1,
    queue: "601",
    selectedExtension: null,
    selectionEffect: "claim",
    status: "available",
    ...overrides,
  };
}

describe("workplace management UI state", () => {
  it("ponúkne prevzatie a uvoľnenie iba podľa serverového oprávnenia", () => {
    expect(getWorkplaceManagementState(seat({
      management: {
        takeover: "allowed",
        release: "allowed",
      },
    }))).toEqual({
      reason: undefined,
      refreshable: false,
      releaseAllowed: true,
      takeoverAllowed: true,
      takeoverBlocked: false,
    });
  });

  it("zobrazí presný serverový dôvod zablokovaného prevzatia", () => {
    expect(getWorkplaceManagementState(seat({
      management: {
        takeover: "blocked",
        release: "blocked",
        reason: "Telefón je stále pripojený vo VIPTel.",
      },
    }))).toEqual({
      reason: "Telefón je stále pripojený vo VIPTel.",
      refreshable: false,
      releaseAllowed: false,
      takeoverAllowed: false,
      takeoverBlocked: true,
    });
  });

  it("neukáže administrátorské akcie bez management kontraktu", () => {
    expect(getWorkplaceManagementState(seat())).toEqual({
      reason: undefined,
      refreshable: false,
      releaseAllowed: false,
      takeoverAllowed: false,
      takeoverBlocked: false,
    });
  });

  it("ignoruje management údaje na mieste, ktoré už nie je obsadené", () => {
    expect(getWorkplaceManagementState(seat({
      status: "available",
      management: {
        takeover: "allowed",
        release: "allowed",
      },
    }))).toEqual({
      reason: undefined,
      refreshable: false,
      releaseAllowed: false,
      takeoverAllowed: false,
      takeoverBlocked: false,
    });
  });

  it.each([
    ["ringing", "Na pracovnom mieste práve zvoní hovor."],
    ["on_call", "Na pracovnom mieste práve prebieha hovor."],
    ["ready", "Telefón je stále pripojený vo VIPTel."],
    ["paused", "Pracovné miesto je vo VIPTel v stave Pauza. Pred prevzatím musí byť nastavené ako Dostupné."],
    ["unverified", "Živý stav telefónu nie je potvrdený. Obnov stav."],
  ] as const)("zablokuje povolenú správu pri živom stave %s", (state, reason) => {
    expect(getWorkplaceManagementState(seat({
      management: { takeover: "allowed", release: "allowed" },
    }), { state })).toEqual({
      reason,
      refreshable: true,
      releaseAllowed: false,
      takeoverAllowed: false,
      takeoverBlocked: true,
    });
  });

  it("zobrazí obnovenie iba pri serverom označenom dočasnom blokovaní", () => {
    expect(getWorkplaceManagementState(seat({
      management: {
        takeover: "blocked",
        release: "blocked",
        reason: "Živý stav telefónu nie je potvrdený. Obnov stav.",
        refreshable: true,
      },
    })).refreshable).toBe(true);
  });
});

describe("dynamic workplace seat UI state", () => {
  it.each(["20", "21", "22", "23"])("ponúkne rovnaký výber na voľnom mieste %s", (extension) => {
    expect(getWorkplaceSeatUiState(seat({
      extension,
      profileId: undefined,
      profileName: undefined,
      status: "free",
      canSelect: true,
    }), "")).toMatchObject({
      action: "select",
      state: "free",
    });
  });

  it("umožní bežné obsadenie stale miesta bez administrátorskej akcie", () => {
    expect(getWorkplaceSeatUiState(seat({
      status: "stale",
      canSelect: true,
      owner: { profileId: "operator-mango", profileName: "Mango Mango" },
      reason: "Operátor je offline viac než 60 sekúnd.",
    }), "20")).toEqual({
      action: "take_stale",
      ownerName: "Mango Mango",
      reason: "Operátor je offline viac než 60 sekúnd.",
      state: "stale",
    });
  });

  it.each([
    ["active", "Aktívny operátor", "blocked"],
    ["transitioning", "Bezpečne dokončujem presun.", "retry"],
    ["unknown", "VIPTel stav je neznámy.", "blocked"],
  ] as const)("zablokuje stav %s s lokalizovaným dôvodom", (status, reason, action) => {
    expect(getWorkplaceSeatUiState(seat({ status, canSelect: false, reason }), "20")).toMatchObject({
      action,
      reason,
      state: status,
    });
  });

  it("rozlíši prechod na inú voľnú stoličku od prvého prihlásenia", () => {
    const available = seat({ status: "free", profileId: undefined, profileName: undefined });
    expect(getWorkplaceSeatUiState(available, "20").action).toBe("switch");
    expect(getWorkplaceSeatUiState(available, "").action).toBe("select");
  });
});

describe("self-service workplace priority UI state", () => {
  it("zablokuje cudzie obsadené poradie bez ponuky swapu alebo vytlačenia", () => {
    const result = getWorkplacePriorityUiState(priority({
      activeExtension: "21",
      selectedExtension: "21",
      selectionEffect: "replace",
      status: "occupied",
      profileId: "operator-mango",
      profileName: "Mango Mango",
      willDisplace: { extension: "21", profileId: "operator-mango", profileName: "Mango Mango" },
    }), "20", seat({ status: "active" }));

    expect(result).toMatchObject({ kind: "foreign", selectable: false });
    expect(result.reason).toContain("Nedá sa mu odobrať voľbou poradia");
    expect(result.reason).toContain("najprv obsad jeho pracovné miesto");
  });

  it("povolí poradie priradené ku skutočne voľnému miestu bez operátora", () => {
    expect(getWorkplacePriorityUiState(priority({
      activeExtension: "21",
      selectedExtension: "21",
      selectionEffect: "replace",
      status: "occupied",
    }), "20", seat({
      status: "free",
      profileId: undefined,
      profileName: undefined,
      owner: undefined,
    }))).toMatchObject({ kind: "unowned", selectable: true });
  });

  it("ponechá sirotské miesto v jeho existujúcom poradí počas bezpečného obnovenia", () => {
    expect(getWorkplacePriorityUiState(priority({
      activeExtension: "21",
      selectedExtension: "21",
      selectionEffect: "replace",
      status: "occupied",
    }), "20", seat({
      status: "stale",
      profileId: undefined,
      profileName: undefined,
      owner: undefined,
      registered: true,
    }))).toMatchObject({ kind: "unowned", selectable: true });
  });

  it("povolí vlastné aj úplne voľné poradie a zablokuje rozpracovanú cudziu zmenu", () => {
    expect(getWorkplacePriorityUiState(priority({
      activeExtension: "20",
      selectedExtension: "20",
      status: "mine",
      selectionEffect: "mine",
    }), "20").selectable).toBe(true);
    expect(getWorkplacePriorityUiState(priority(), "20").selectable).toBe(true);
    expect(getWorkplacePriorityUiState(priority({ status: "pending_occupied" }), "20")).toMatchObject({
      kind: "transitioning",
      selectable: false,
    });
  });
});

describe("takeover phone handshake feedback", () => {
  it("potvrdí úspech po prijatej registrácii telefónu v prehliadači", () => {
    expect(buildTakeoverPhoneHandshakeResult({
      extension: "21",
      outcome: "confirmed",
      serverMessage: "Pracovné miesto bolo bezpečne prevzaté.",
    })).toEqual({
      message: "Pracovné miesto bolo bezpečne prevzaté. Telefón v prehliadači je pripojený.",
      state: "confirmed",
    });
  });

  it("timeout označí ako čiastočný úspech bez výzvy opakovať prevzatie", () => {
    const result = buildTakeoverPhoneHandshakeResult({ extension: "21", outcome: "timeout" });

    expect(result.state).toBe("warning");
    expect(result.message).toContain("Pracovné miesto 21 je prevzaté, ale telefón sa nepripojil.");
    expect(result.message).toContain("pracovné miesto už nepreberaj opakovane");
  });

  it("zachová konkrétny dôvod zlyhania pripojenia", () => {
    const result = buildTakeoverPhoneHandshakeResult({
      detail: "Prístup k mikrofónu bol zamietnutý.",
      extension: "21",
      outcome: "failed",
    });

    expect(result.state).toBe("warning");
    expect(result.message).toContain("Prístup k mikrofónu bol zamietnutý.");
  });

  it("neoznačí telefón bez poradia ako pripravený na prichádzajúce hovory", () => {
    const result = buildTakeoverPhoneHandshakeResult({ extension: "21", outcome: "outbound_only" });

    expect(result.state).toBe("confirmed");
    expect(result.message).toContain("pre odchádzajúce a interné hovory");
    expect(result.message).toContain("Pre prichádzajúce hovory ešte vyber a potvrď poradie");
  });

  it("pri nezrušenej Pauze pravdivo ponechá inbound v údržbovom stave", () => {
    const result = buildTakeoverPhoneHandshakeResult({
      detail: "VIPTel zmenu nepotvrdil.",
      extension: "21",
      outcome: "maintenance",
    });

    expect(result.state).toBe("warning");
    expect(result.message).toContain("VIPTel ho ponechal v stave Pauza");
    expect(result.message).toContain("iba odchádzajúce alebo interné hovory");
    expect(result.message).toContain("zvoľ Dostupný");
  });
});
