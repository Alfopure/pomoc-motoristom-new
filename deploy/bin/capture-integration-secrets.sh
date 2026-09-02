#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:-"${repo_root}/.context/secrets/integration-runtime.env"}
mkdir -p "$(dirname "$output")"
temporary=$(mktemp "${output}.tmp.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT INT TERM
chmod 600 "$temporary"
if [[ -e "$output" ]]; then
  [[ -f "$output" && ! -L "$output" ]] || { echo "Existujúci secret path nie je obyčajný súbor." >&2; exit 1; }
  (( (8#$(stat -f '%Lp' "$output") & 8#077) == 0 )) || { echo "Existujúci secret súbor musí mať mode 600 alebo prísnejší." >&2; exit 1; }
  cp -p -- "$output" "$temporary"
  chmod 600 "$temporary"
fi

prompt_value() {
  local key=$1
  local label=$2
  local value
  printf '%s (Enter = zatiaľ preskočiť): ' "$label" >/dev/tty
  IFS= read -r -s value </dev/tty
  printf '\n' >/dev/tty
  [[ -n "$value" ]] || return 0
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "Hodnota ${key} obsahuje nepovolený nový riadok." >&2
    exit 1
  fi
  local replacement
  replacement=$(mktemp "${output}.replace.XXXXXX")
  chmod 600 "$replacement"
  awk -F= -v key="$key" '$1 != key' "$temporary" >"$replacement"
  mv -f -- "$replacement" "$temporary"
  printf '%s=' "$key" >>"$temporary"
  printf '%s' "$value" | node -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => value += chunk);
    process.stdin.on("end", () => process.stdout.write(JSON.stringify(value)));
  ' >>"$temporary"
  printf '\n' >>"$temporary"
  unset value
}

echo "Hodnoty sa nezobrazia a uložia sa iba lokálne do mode-600 súboru." >/dev/tty
prompt_value COMMANDER_API_USERNAME "Commander API používateľ"
prompt_value COMMANDER_API_PASSWORD "Commander API heslo"
prompt_value WEBDISPECINK_COMPANY_CODE "WebDispecink kód firmy"
prompt_value WEBDISPECINK_USERNAME "WebDispecink používateľ"
prompt_value WEBDISPECINK_PASSWORD "WebDispecink heslo"
prompt_value VIPTEL_USERNAME "VIPTel PBX API používateľ"
prompt_value VIPTEL_PASSWORD "VIPTel PBX API heslo"
prompt_value ANTHROPIC_API_KEY "Anthropic API kľúč pre prepisy"
prompt_value RESEND_API_KEY "Resend API kľúč pre upozornenia"
prompt_value HEALTHCHECKS_PING_URL "Healthchecks URL pre worker"
prompt_value VIPTEL_HEALTHCHECKS_PING_URL "Healthchecks URL pre VIPTel listener"
prompt_value HEALTHCHECKS_JOB_URLS_JSON "JSON mapa Healthchecks URL pre jednotlivé joby"
prompt_value HCLOUD_READ_TOKEN "Hetzner read-only token pre denný audit"

mv -f -- "$temporary" "$output"
chmod 600 "$output"
trap - EXIT INT TERM
echo "Bezpečne uložené: ${output}. Hodnoty neboli vypísané."
