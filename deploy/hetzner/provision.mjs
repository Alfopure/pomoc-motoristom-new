#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { EXPECTED, getCostPreflight, hcloud, listAll, waitForAction } from "./lib.mjs";

if (!process.argv.includes("--confirm-create-under-11-eur")) {
  throw new Error("Refusing mutation without --confirm-create-under-11-eur.");
}

const adminCidr = process.env.ADMIN_SSH_CIDR?.trim();
if (!adminCidr || !/^\d{1,3}(?:\.\d{1,3}){3}\/32$/.test(adminCidr)) {
  throw new Error("ADMIN_SSH_CIDR must be one IPv4 /32 CIDR.");
}

const publicKeyPath = resolve(process.env.SSH_PUBLIC_KEY_PATH ?? `${homedir()}/.ssh/id_ed25519.pub`);
const publicKey = (await readFile(publicKeyPath, "utf8")).trim();
if (!/^ssh-ed25519\s+\S+/.test(publicKey)) throw new Error("Expected an Ed25519 SSH public key.");

const preflight = await getCostPreflight({ allowMissingBackup: true });
if (preflight.existing) {
  const servers = await listAll(`/servers?name=${encodeURIComponent(EXPECTED.serverName)}`, "servers");
  const server = servers[0];
  if (!preflight.backupsEnabled) {
    const backupAction = await hcloud(`/servers/${server.id}/actions/enable_backup`, {
      method: "POST",
      body: "{}",
    });
    if (backupAction.action?.id) await waitForAction(backupAction.action.id);
  }
  const postflight = await getCostPreflight();
  console.log(
    JSON.stringify(
      {
        created: false,
        repairedBackups: !preflight.backupsEnabled,
        serverId: server.id,
        ipv4: server.public_net.ipv4.ip,
        monthlyGrossEur: Number(postflight.totalGross.toFixed(2)),
        inventory: postflight.inventory,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const existingKeys = await listAll(`/ssh_keys?name=${encodeURIComponent(EXPECTED.sshKeyName)}`, "ssh_keys");
let sshKey = existingKeys[0];
if (!sshKey) {
  const created = await hcloud("/ssh_keys", {
    method: "POST",
    body: JSON.stringify({
      name: EXPECTED.sshKeyName,
      public_key: publicKey,
      labels: { app: "motorist-dispatch", environment: "production" },
    }),
  });
  sshKey = created.ssh_key;
}

const rules = [
  { direction: "in", protocol: "tcp", port: "22", source_ips: [adminCidr] },
  { direction: "in", protocol: "tcp", port: "80", source_ips: ["0.0.0.0/0", "::/0"] },
  { direction: "in", protocol: "tcp", port: "443", source_ips: ["0.0.0.0/0", "::/0"] },
  { direction: "in", protocol: "udp", port: "443", source_ips: ["0.0.0.0/0", "::/0"] },
  { direction: "in", protocol: "icmp", source_ips: ["0.0.0.0/0", "::/0"] },
];

const existingFirewalls = await listAll(
  `/firewalls?name=${encodeURIComponent(EXPECTED.firewallName)}`,
  "firewalls",
);
let firewall = existingFirewalls[0];
if (!firewall) {
  const created = await hcloud("/firewalls", {
    method: "POST",
    body: JSON.stringify({
      name: EXPECTED.firewallName,
      labels: { app: "motorist-dispatch", environment: "production" },
      rules,
    }),
  });
  firewall = created.firewall;
} else {
  const actionBody = await hcloud(`/firewalls/${firewall.id}/actions/set_rules`, {
    method: "POST",
    body: JSON.stringify({ rules }),
  });
  if (actionBody.action?.id) await waitForAction(actionBody.action.id);
}

const cloudInitTemplate = await readFile(new URL("./cloud-init.yaml", import.meta.url), "utf8");
const userData = cloudInitTemplate.replace("__DEPLOY_SSH_PUBLIC_KEY__", publicKey);

// The price gate runs immediately before this sole paid mutation.
await getCostPreflight();
const created = await hcloud("/servers", {
  method: "POST",
  body: JSON.stringify({
    name: EXPECTED.serverName,
    server_type: EXPECTED.serverType,
    image: EXPECTED.image,
    location: EXPECTED.location,
    start_after_create: true,
    ssh_keys: [sshKey.id],
    firewalls: [{ firewall: firewall.id }],
    public_net: { enable_ipv4: true, enable_ipv6: true },
    user_data: userData,
    labels: { app: "motorist-dispatch", environment: "production", "managed-by": "api" },
  }),
});

if (created.action?.id) await waitForAction(created.action.id);

const backupAction = await hcloud(`/servers/${created.server.id}/actions/enable_backup`, {
  method: "POST",
  body: "{}",
});
if (backupAction.action?.id) await waitForAction(backupAction.action.id);

const postflight = await getCostPreflight();
console.log(
  JSON.stringify(
    {
      created: true,
      serverId: created.server.id,
      ipv4: created.server.public_net.ipv4.ip,
      monthlyGrossEur: Number(postflight.totalGross.toFixed(2)),
      conservative27PercentVatEur: Number(postflight.conservativeGross.toFixed(2)),
      inventory: postflight.inventory,
    },
    null,
    2,
  ),
);
