#!/usr/bin/env bash
# Creates an isolated copy of this application for the AI demo test.
#
# Why a copy: the live test needs two public webhook endpoints, and pointing
# them at the `dev` alias would mean testing on the same deployment and the same
# database other people are working on. This script builds a throwaway pair —
# a new Supabase project and a new Vercel project — so the experiment cannot
# touch either.
#
# Two deliberate properties:
#
#  * The Vercel project is NOT connected to the Git repository. It is deployed
#    from the working tree with `vercel deploy`, so nobody else's push can
#    redeploy it and it will never acquire a production domain.
#  * `CRON_SECRET` is not copied. Without it `/api/telephony/cron` answers 401,
#    so the copy cannot run a second scheduler against the shared account.
#
# Everything except the Supabase values and the AI demo block is copied from the
# existing project's Preview environment, so Telnyx, e-mail and the rest keep
# working without anybody retyping a secret.
#
# Usage:
#   cp scripts/ai-demo-copy.secrets.example .context/ai-demo-copy.secrets
#   # fill it in, then:
#   bash scripts/setup-ai-demo-copy.sh
#
# Re-running is safe: existing resources are reused, not recreated.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="${AI_DEMO_COPY_SECRETS:-$ROOT/.context/ai-demo-copy.secrets}"

if [ ! -f "$SECRETS" ]; then
  echo "Missing $SECRETS — copy scripts/ai-demo-copy.secrets.example there and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$SECRETS"; set +a

require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing $name in $SECRETS" >&2
    exit 1
  fi
}
require VERCEL_TOKEN
require SUPABASE_ACCESS_TOKEN
require SUPABASE_DB_PASSWORD
require SUPABASE_ORG_ID
require SOURCE_VERCEL_PROJECT

COPY_NAME="${COPY_NAME:-pomoc-motoristom-aidemo}"
SUPABASE_REGION="${SUPABASE_REGION:-eu-central-1}"
VERCEL_SCOPE_ARG=()
[ -n "${VERCEL_SCOPE:-}" ] && VERCEL_SCOPE_ARG=(--scope "$VERCEL_SCOPE")

# The isolation guard in AGENTS.md, restated here because this script is the one
# place that talks to the accounts.
case "$SOURCE_VERCEL_PROJECT" in
  *dispecing*|*sjcsrygkkmersoczpunh*)
    echo "Refusing: $SOURCE_VERCEL_PROJECT looks like the original production project." >&2
    exit 1
    ;;
esac

export VERCEL_TOKEN SUPABASE_ACCESS_TOKEN
vercel() { command vercel --token "$VERCEL_TOKEN" "${VERCEL_SCOPE_ARG[@]}" "$@"; }

step() { printf '\n▶ %s\n' "$1"; }

# ── 1. Supabase copy ─────────────────────────────────────────────────────────
step "Supabase project"
PROJECT_REF="${SUPABASE_PROJECT_REF_OVERRIDE:-}"
if [ -z "$PROJECT_REF" ]; then
  PROJECT_REF="$(supabase projects list --output json 2>/dev/null \
    | python3 -c "import json,sys;rows=json.load(sys.stdin);print(next((r['id'] for r in rows if r['name']=='$COPY_NAME'),''))" || true)"
fi

if [ -z "$PROJECT_REF" ]; then
  echo "  creating $COPY_NAME in $SUPABASE_REGION…"
  supabase projects create "$COPY_NAME" \
    --org-id "$SUPABASE_ORG_ID" \
    --db-password "$SUPABASE_DB_PASSWORD" \
    --region "$SUPABASE_REGION" >/dev/null
  PROJECT_REF="$(supabase projects list --output json \
    | python3 -c "import json,sys;rows=json.load(sys.stdin);print(next(r['id'] for r in rows if r['name']=='$COPY_NAME'))")"
  echo "  waiting for it to come up…"
  for _ in $(seq 1 60); do
    supabase projects api-keys --project-ref "$PROJECT_REF" >/dev/null 2>&1 && break
    sleep 10
  done
fi
echo "  ref: $PROJECT_REF"

if [ "$PROJECT_REF" = "sjcsrygkkmersoczpunh" ]; then
  echo "Refusing: that is the original production database." >&2
  exit 1
fi

step "Schema and seed"
KEYS_JSON="$(supabase projects api-keys --project-ref "$PROJECT_REF" --output json)"
read_key() { printf '%s' "$KEYS_JSON" | python3 -c "import json,sys;print(next((k['api_key'] for k in json.load(sys.stdin) if k['name']=='$1'),''))"; }
ANON_KEY="$(read_key anon)"
SERVICE_KEY="$(read_key service_role)"
[ -n "$SERVICE_KEY" ] || { echo "Could not read the service_role key." >&2; exit 1; }

DB_URL="postgresql://postgres.${PROJECT_REF}:${SUPABASE_DB_PASSWORD}@aws-0-${SUPABASE_REGION}.pooler.supabase.com:6543/postgres"
(
  cd "$ROOT"
  supabase link --project-ref "$PROJECT_REF" --password "$SUPABASE_DB_PASSWORD" >/dev/null
  supabase db push --password "$SUPABASE_DB_PASSWORD"
)
echo "  migrations applied (including 20261002100000_ai_demo.sql)"

if [ "${SEED_DEMO_DATA:-true}" = "true" ]; then
  PGPASSWORD="$SUPABASE_DB_PASSWORD" psql \
    "postgresql://postgres.${PROJECT_REF}@aws-0-${SUPABASE_REGION}.pooler.supabase.com:5432/postgres" \
    -v ON_ERROR_STOP=1 -qf "$ROOT/supabase/seed.sql" >/dev/null
  echo "  seed applied (demo organisation and lines; no real cases)"
fi

# ── 2. Vercel copy ───────────────────────────────────────────────────────────
step "Vercel project"
if ! vercel project ls 2>/dev/null | grep -qx "  $COPY_NAME" && ! vercel project ls 2>/dev/null | grep -q "\b$COPY_NAME\b"; then
  vercel project add "$COPY_NAME" >/dev/null
  echo "  created $COPY_NAME"
else
  echo "  reusing $COPY_NAME"
fi

step "Environment"
ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
(cd "$ROOT" && vercel env pull "$ENV_FILE" --environment=preview --yes >/dev/null 2>&1) \
  || { echo "Could not read the source project's Preview environment. Link it first: vercel link --project $SOURCE_VERCEL_PROJECT" >&2; exit 1; }

# Values the copy must own rather than inherit.
python3 - "$ENV_FILE" "$PROJECT_REF" "$ANON_KEY" "$SERVICE_KEY" "$DB_URL" <<'PY' > "$ENV_FILE.copy"
import re, sys
path, ref, anon, service, db_url = sys.argv[1:6]
override = {
    "NEXT_PUBLIC_SUPABASE_URL": f"https://{ref}.supabase.co",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY": anon,
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": anon,
    "SUPABASE_SECRET_KEY": service,
    "SUPABASE_SERVICE_ROLE_KEY": service,
    "SUPABASE_PROJECT_REF": ref,
    "EXPECTED_SUPABASE_PROJECT_REF": ref,
    "SUPABASE_DB_URL": db_url,
    # Off until the operator turns them on for the test window.
    "AI_DEMO_ENABLED": "false",
    "TELNYX_LIVE_CALLS_ENABLED": "false",
    "TELNYX_SMS_LIVE_SENDS": "false",
    "SCHEDULER_ENABLED": "false",
    "DEPLOYMENT_VERSION": "ai-demo-copy",
}
# Never copied: the cron bearer (a second scheduler), and anything that would
# let the copy send mail or SMS to real people.
drop = {"CRON_SECRET", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "HEALTHCHECKS_PING_URL", "ALERT_EMAIL_TO"}

seen = set()
for line in open(path, encoding="utf-8"):
    line = line.rstrip("\n")
    match = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', line)
    if not match:
        continue
    key, value = match.group(1), match.group(2)
    if key in drop:
        continue
    if key in override:
        value = override.pop(key)
    seen.add(key)
    if value.startswith('"') and value.endswith('"'):
        value = value[1:-1]
    print(f"{key}={value}")
for key, value in override.items():
    print(f"{key}={value}")
PY

while IFS='=' read -r KEY VALUE; do
  [ -z "$KEY" ] && continue
  for TARGET in production preview development; do
    printf '%s' "$VALUE" | (cd "$ROOT" && VERCEL_PROJECT_NAME="$COPY_NAME" vercel env add "$KEY" "$TARGET" --force >/dev/null 2>&1) || true
  done
done < "$ENV_FILE.copy"
echo "  $(wc -l < "$ENV_FILE.copy") variables set on $COPY_NAME"

cat <<NEXT

▶ Nearly there. The copy exists but has not been deployed yet.

  1. Deploy from this working tree (not from Git, on purpose):
       cd $ROOT
       vercel link --project $COPY_NAME --yes
       vercel deploy --prod --token \$VERCEL_TOKEN

  2. Note the URL it prints — call it \$COPY_URL — and set two more variables:
       vercel env add APP_BASE_URL production   # \$COPY_URL
       vercel env add NEXT_PUBLIC_APP_URL production

  3. Telnyx: create a NEW Call Control application for the copy with
       webhook_event_url = \$COPY_URL/api/telephony/telnyx/webhook
     and put its id in TELNYX_CALL_CONTROL_APP_ID on the copy.

  4. OpenAI (https://platform.openai.com/settings/project/webhooks):
     endpoint \$COPY_URL/api/telephony/webhooks/openai, event
     live.transport.incoming only. Save the signing secret into
     OPENAI_WEBHOOK_SECRET, and the project id from
     https://platform.openai.com/settings into OPENAI_LIVE_PROJECT_ID.

  5. Set AI_DEMO_ALLOWED_RECIPIENTS to the mobile that will answer, then flip
     AI_DEMO_ENABLED and TELNYX_LIVE_CALLS_ENABLED to true and redeploy.

  Supabase project: $PROJECT_REF
  Vercel project:   $COPY_NAME

  Deleting the copy afterwards removes every trace: both projects are new and
  nothing else points at them.
NEXT
