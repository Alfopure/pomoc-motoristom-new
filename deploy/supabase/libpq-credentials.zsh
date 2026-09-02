#!/bin/zsh

# Source this file from migration scripts. It converts a password-bearing
# Postgres URL received through stdin into a password-free URL plus a protected
# pgpass file. Database clients therefore never receive a password in argv.

typeset -gr LIBPQ_MIGRATION_ROOT="${${(%):-%x}:A:h:h:h}"
typeset -gr LIBPQ_RELAY_CA_FILE="${LIBPQ_MIGRATION_ROOT}/.context/secrets/supabase-prod-ca-2021.crt"
typeset -gr LIBPQ_RELAY_CA_CONTAINER_PATH="/run/secrets/supabase-ca.crt"

migration_docker_run() {
  typeset -a relay_args
  relay_args=()

  case "${MIGRATION_DOCKER_SSH_RELAY:-0}" in
    0) ;;
    1)
      if [[ "$(uname -s)" != Darwin ]]; then
        print -u2 -- "MIGRATION_DOCKER_SSH_RELAY=1 je povolené iba na macOS migrátore."
        return 1
      fi
      if [[ ! -r "${LIBPQ_RELAY_CA_FILE}" ]] || \
         ! openssl x509 -in "${LIBPQ_RELAY_CA_FILE}" -noout -checkend 86400 >/dev/null 2>&1; then
        print -u2 -- "Chýba platný Supabase DB CA certifikát pre relay."
        return 1
      fi
      relay_args=(
        --add-host "db.jcwbiulwuwyrnmzjjbgr.supabase.co:host-gateway"
        --add-host "db.sjcsrygkkmersoczpunh.supabase.co:host-gateway"
        --mount "type=bind,source=${LIBPQ_RELAY_CA_FILE},target=${LIBPQ_RELAY_CA_CONTAINER_PATH},readonly"
        --env PGSSLMODE=verify-full
        --env "PGSSLROOTCERT=${LIBPQ_RELAY_CA_CONTAINER_PATH}"
        --env PGCONNECT_TIMEOUT=10
        --env "PGOPTIONS=-c role=postgres"
      )
      ;;
    *)
      print -u2 -- "MIGRATION_DOCKER_SSH_RELAY musí byť 0 alebo 1."
      return 1
      ;;
  esac

  command docker run "${relay_args[@]}" "$@"
}

libpq_url_matches_project() {
  local database_url="$1"
  local project_ref="$2"
  local allow_local_rehearsal="${3:-0}"

  print -rn -- "${database_url}" | \
      LIBPQ_EXPECTED_PROJECT_REF="${project_ref}" \
      LIBPQ_ALLOW_LOCAL_REHEARSAL="${allow_local_rehearsal}" \
      LIBPQ_DOCKER_SSH_RELAY="${MIGRATION_DOCKER_SSH_RELAY:-0}" \
    node -e '
      const fs = require("node:fs");
      let parsed;
      try {
        parsed = new URL(fs.readFileSync(0, "utf8"));
      } catch {
        process.exit(1);
      }
      const ref = process.env.LIBPQ_EXPECTED_PROJECT_REF;
      const protocolOk = ["postgres:", "postgresql:"].includes(parsed.protocol);
      const username = decodeURIComponent(parsed.username);
      const temporaryCliRole = /^cli_login_[a-z0-9_]+$/.test(username);
      const hostaddr = parsed.searchParams.get("hostaddr");
      const relayEnabled = process.env.LIBPQ_DOCKER_SSH_RELAY === "1";
      const localRehearsal = process.env.LIBPQ_ALLOW_LOCAL_REHEARSAL === "1";
      const relayPort = ref === "jcwbiulwuwyrnmzjjbgr" ? "15432"
        : ref === "sjcsrygkkmersoczpunh" ? "25432"
        : "";
      const relayUsesVerifiedTls = !hostaddr || (
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostaddr)
        && parsed.searchParams.get("sslmode") === "verify-full"
        && parsed.searchParams.get("sslrootcert") === "system"
      );
      const relayParams = [
        ["sslmode", "verify-full"],
        ["sslrootcert", "/run/secrets/supabase-ca.crt"],
        ["connect_timeout", "10"],
      ];
      const relayParamsExact = parsed.searchParams.size === relayParams.length
        && relayParams.every(([name, value]) => (
          parsed.searchParams.getAll(name).length === 1
          && parsed.searchParams.get(name) === value
        ));
      const relayConfigOk = !relayEnabled || (
        parsed.port === relayPort
        && !hostaddr
        && !localRehearsal
        && relayParamsExact
      );
      const direct = parsed.hostname === `db.${ref}.supabase.co`
        && (relayEnabled
          ? temporaryCliRole
          : (username === "postgres" || temporaryCliRole))
        && relayUsesVerifiedTls
        && relayConfigOk;
      const pooler = !relayEnabled
        && parsed.hostname.endsWith(".pooler.supabase.com")
        && username === `postgres.${ref}`;
      const local = !relayEnabled && localRehearsal
        && ["host.docker.internal", "127.0.0.1", "localhost"].includes(parsed.hostname)
        && username === `postgres.${ref}`;
      process.exit(protocolOk
        && parsed.pathname === "/postgres"
        && !parsed.hash
        && parsed.password
        && !/[\r\n]/.test(parsed.password)
        && (direct || pooler || local) ? 0 : 1);
    '
}

libpq_prepare_credentials() {
  local database_url="$1"
  local secret_dir="$2"
  local label="$3"

  LIBPQ_PGPASS_FILE="$(mktemp "${secret_dir}/.pgpass-${label}.XXXXXX")"
  local safe_url_file
  safe_url_file="$(mktemp "${secret_dir}/.database-url-${label}.XXXXXX")"
  chmod 600 "${LIBPQ_PGPASS_FILE}" "${safe_url_file}"

  if ! print -rn -- "${database_url}" | \
    LIBPQ_PGPASS_OUTPUT="${LIBPQ_PGPASS_FILE}" \
    LIBPQ_SAFE_URL_OUTPUT="${safe_url_file}" \
    node -e '
      const fs = require("node:fs");
      const raw = fs.readFileSync(0, "utf8");
      const parsed = new URL(raw);
      if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
        throw new Error("unsupported database URL protocol");
      }
      if (!parsed.hostname || !parsed.username || !parsed.password) {
        throw new Error("database URL must contain host, username, and password");
      }

      const decode = (value) => decodeURIComponent(value);
      const escapePgpass = (value) => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
      const username = decode(parsed.username);
      const password = decode(parsed.password);
      const database = decode(parsed.pathname.replace(/^\//, "")) || "postgres";
      const port = parsed.port || "5432";
      if ([username, password, database].some((value) => /[\r\n]/.test(value))) {
        throw new Error("database credentials contain a line break");
      }

      const pgpass = [parsed.hostname, port, database, username, password]
        .map(escapePgpass)
        .join(":") + "\n";
      fs.writeFileSync(process.env.LIBPQ_PGPASS_OUTPUT, pgpass, { mode: 0o600 });

      parsed.password = "";
      fs.writeFileSync(process.env.LIBPQ_SAFE_URL_OUTPUT, parsed.toString() + "\n", { mode: 0o600 });
    '; then
    rm -f -- "${LIBPQ_PGPASS_FILE}" "${safe_url_file}"
    unset LIBPQ_PGPASS_FILE
    return 1
  fi

  LIBPQ_SAFE_URL="$(<"${safe_url_file}")"
  rm -f -- "${safe_url_file}"
  chmod 600 "${LIBPQ_PGPASS_FILE}"
}

libpq_cleanup_credentials() {
  rm -f -- "${LIBPQ_PGPASS_FILE:-}"
  unset LIBPQ_PGPASS_FILE LIBPQ_SAFE_URL
}
