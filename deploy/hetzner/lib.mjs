const API_BASE = "https://api.hetzner.cloud/v1";

export const EXPECTED = Object.freeze({
  serverName: "motorist-prod-01",
  firewallName: "motorist-prod-firewall",
  sshKeyName: "motorist-prod-deploy",
  serverType: "cx23",
  location: "nbg1",
  image: "ubuntu-24.04",
  budgetEur: 11,
});

export function requireToken() {
  const token = process.env.HCLOUD_TOKEN?.trim();
  if (!token) {
    throw new Error("HCLOUD_TOKEN is missing.");
  }
  return token;
}

export async function hcloud(path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireToken()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = body?.error?.code ?? `http_${response.status}`;
    const message = body?.error?.message ?? "Hetzner API request failed.";
    throw new Error(`${code}: ${message}`);
  }
  return body;
}

export async function listAll(path, key) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const body = await hcloud(`${path}${separator}page=${page}&per_page=50`);
    items.push(...(body[key] ?? []));
    if (!body.meta?.pagination?.next_page) break;
  }
  return items;
}

function money(value) {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) throw new Error(`Invalid price: ${value}`);
  return amount;
}

export async function getCostPreflight({ allowMissingBackup = false } = {}) {
  const [pricingBody, servers, primaryIps, volumes, floatingIps, loadBalancers] = await Promise.all([
    hcloud("/pricing"),
    listAll("/servers", "servers"),
    listAll("/primary_ips", "primary_ips"),
    listAll("/volumes", "volumes"),
    listAll("/floating_ips", "floating_ips"),
    listAll("/load_balancers", "load_balancers"),
  ]);

  const pricing = pricingBody.pricing;
  if (pricing.currency !== "EUR") {
    throw new Error(`Expected EUR billing currency, received ${pricing.currency}.`);
  }

  if (volumes.length || floatingIps.length || loadBalancers.length) {
    throw new Error("Unexpected paid resource exists (volume, Floating IP, or load balancer).");
  }
  if (servers.length > 1) throw new Error("More than one server exists in the project.");

  const unexpectedServer = servers.find(
    (server) => server.name !== EXPECTED.serverName || server.server_type?.name !== EXPECTED.serverType,
  );
  if (unexpectedServer) throw new Error("An unexpected server exists; refusing to provision.");

  const ipv4Inventory = primaryIps.filter((ip) => ip.type === "ipv4");
  const expectedServerId = servers[0]?.id;
  const unexpectedIpv4 = ipv4Inventory.filter((ip) => ip.assignee_id !== expectedServerId);
  if (unexpectedIpv4.length || ipv4Inventory.length !== servers.length) {
    throw new Error("Unexpected Primary IPv4 inventory; refusing to provision.");
  }

  const serverTypePrice = pricing.server_types
    .find((entry) => entry.name === EXPECTED.serverType)
    ?.prices.find((entry) => entry.location === EXPECTED.location);
  const ipv4Price = pricing.primary_ips
    .find((entry) => entry.type === "ipv4")
    ?.prices.find((entry) => entry.location === EXPECTED.location);

  if (!serverTypePrice || !ipv4Price) {
    throw new Error("Expected CX23 or Primary IPv4 price is unavailable in NBG1.");
  }

  const serverGross = money(serverTypePrice.price_monthly.gross);
  const ipv4Gross = money(ipv4Price.price_monthly.gross);
  const backupPercentage = money(pricing.server_backup.percentage);
  const backupGross = serverGross * (backupPercentage / 100);
  const totalGross = serverGross + ipv4Gross + backupGross;
  const vatRate = money(pricing.vat_rate);

  // A second conservative calculation protects the budget if account VAT changes.
  const serverNet = money(serverTypePrice.price_monthly.net);
  const ipv4Net = money(ipv4Price.price_monthly.net);
  const conservativeGross = (serverNet + ipv4Net + serverNet * (backupPercentage / 100)) * 1.27;

  if (totalGross > EXPECTED.budgetEur || conservativeGross > EXPECTED.budgetEur) {
    throw new Error(
      `Budget gate failed: current gross ${totalGross.toFixed(2)} EUR, conservative 27% VAT ${conservativeGross.toFixed(2)} EUR.`,
    );
  }

  const existing = servers.length === 1;
  const backupsEnabled = existing ? Boolean(servers[0].backup_window) : false;
  if (existing) {
    const server = servers[0];
    if (!backupsEnabled && !allowMissingBackup) {
      throw new Error("Existing production server does not have backups enabled.");
    }
    if (primaryIps.filter((ip) => ip.type === "ipv4" && ip.assignee_id === server.id).length !== 1) {
      throw new Error("Existing production server does not have exactly one assigned Primary IPv4.");
    }
  }

  return {
    existing,
    backupsEnabled,
    totalGross,
    conservativeGross,
    vatRate,
    includedTrafficBytes: serverTypePrice.included_traffic,
    trafficGrossPerTb: money(serverTypePrice.price_per_tb_traffic.gross),
    inventory: {
      servers: servers.length,
      primaryIpv4: primaryIps.filter((ip) => ip.type === "ipv4").length,
      primaryIpv6: primaryIps.filter((ip) => ip.type === "ipv6").length,
      volumes: volumes.length,
      floatingIps: floatingIps.length,
      loadBalancers: loadBalancers.length,
    },
  };
}

export async function waitForAction(actionId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { action } = await hcloud(`/actions/${actionId}`);
    if (action.status === "success") return action;
    if (action.status === "error") {
      throw new Error(`${action.error?.code ?? "action_failed"}: ${action.error?.message ?? "Unknown action failure"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`Timed out waiting for Hetzner action ${actionId}.`);
}
