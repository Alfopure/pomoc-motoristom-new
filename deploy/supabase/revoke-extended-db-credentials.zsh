#!/bin/zsh

set -euo pipefail
umask 077

readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly FREEZE_ROOT="${ROOT_DIR}/.context/migration/source-freeze"
readonly CUTOVER_RECEIPT_ROOT="${ROOT_DIR}/.context/migration/cutover-receipts"
readonly MANAGEMENT_API_HELPER="${ROOT_DIR}/deploy/supabase/management-api-readonly.zsh"

source "${MANAGEMENT_API_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

cleanup_mode="${1:-}"
case "${cleanup_mode}" in
  --revoke-after-abort)
    [[ "$#" -eq 1 ]] || die "Použitie: ${0:t} --revoke-after-abort"
    ;;
  --revoke-after-cutover)
    [[ "$#" -eq 2 ]] || die "Použitie: ${0:t} --revoke-after-cutover CUTOVER_RECEIPT"
    cutover_receipt="$2"
    ;;
  *)
    die "Použitie: ${0:t} --revoke-after-abort | --revoke-after-cutover CUTOVER_RECEIPT"
    ;;
esac
[[ -r "${SECRET_FILE}" ]] || die "Chýba migračný secret súbor."
if (( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) != 0 )); then
  die "Migračný secret súbor musí mať oprávnenie 600 alebo prísnejšie."
fi

typeset -a active_receipts
active_receipts=("${FREEZE_ROOT}"/*.env(N))
source_freeze_active=false
if (( ${#active_receipts[@]} > 0 )) && grep -Eq '^state=(preparing|restart_requested|frozen)$' "${active_receipts[@]}"; then
  source_freeze_active=true
fi

source "${SECRET_FILE}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"
: "${TARGET_SUPABASE_ACCESS_TOKEN:?TARGET_SUPABASE_ACCESS_TOKEN chýba}"
: "${MIGRATION_DB_CREDENTIAL_RECEIPT:?MIGRATION_DB_CREDENTIAL_RECEIPT chýba}"
[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source project ref nesedí."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."
[[ "${MIGRATION_DB_CREDENTIAL_RECEIPT}" == "${ROOT_DIR}/.context/migration/db-credential-receipts/"*.env ]] || \
  die "Credential receipt cesta nie je povolená."
[[ -r "${MIGRATION_DB_CREDENTIAL_RECEIPT}" ]] || die "Credential receipt chýba."

credential_receipt_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "${MIGRATION_DB_CREDENTIAL_RECEIPT}" | tail -n 1
}

typeset -a refs tokens
case "${cleanup_mode}" in
  --revoke-after-abort)
    [[ "${source_freeze_active}" == false ]] || \
      die "Source je stále frozen/preparing; abort cleanup je zakázaný."
    [[ "${MIGRATION_DB_CREDENTIAL_MODE:-}" == extended_cli_role ]] || \
      die "Abort cleanup očakáva predĺžené CLI roly na oboch projektoch."
    : "${MIGRATION_SOURCE_DB_ROLE:?Source DB rola chýba.}"
    : "${MIGRATION_TARGET_DB_ROLE:?Target DB rola chýba.}"
    [[ "$(credential_receipt_value state)" == active_extended_cli_roles ]] || \
      die "Credential receipt nepotvrdzuje aktívne roly na oboch projektoch."
    [[ "$(credential_receipt_value source_role)" == "${MIGRATION_SOURCE_DB_ROLE}" ]] || \
      die "Source rola nesedí s credential receiptom."
    [[ "$(credential_receipt_value target_role)" == "${MIGRATION_TARGET_DB_ROLE}" ]] || \
      die "Target rola nesedí s credential receiptom."
    refs=("${EXPECTED_SOURCE_REF}" "${EXPECTED_TARGET_REF}")
    tokens=("${SOURCE_SUPABASE_ACCESS_TOKEN}" "${TARGET_SUPABASE_ACCESS_TOKEN}")
    ;;
  --revoke-after-cutover)
    [[ "${source_freeze_active}" == true ]] || \
      die "Cutover cleanup očakáva source stále frozen."
    [[ "${MIGRATION_DB_CREDENTIAL_MODE:-}" == target_extended_cli_source_management_api ]] || \
      die "Cutover cleanup očakáva iba predĺženú target CLI rolu."
    : "${MIGRATION_TARGET_DB_ROLE:?Target DB rola chýba.}"
    [[ "$(credential_receipt_value state)" == active_extended_target_cli_source_management_api ]] || \
      die "Credential receipt nepotvrdzuje aktívnu target rolu."
    [[ "$(credential_receipt_value target_role)" == "${MIGRATION_TARGET_DB_ROLE}" ]] || \
      die "Target rola nesedí s credential receiptom."
    [[ "${cutover_receipt}" == "${CUTOVER_RECEIPT_ROOT}/cutover-"*.jsonl ]] || \
      die "Cutover receipt cesta nie je povolená."
    [[ -f "${cutover_receipt}" && -r "${cutover_receipt}" && ! -L "${cutover_receipt}" ]] || \
      die "Cutover receipt chýba alebo nie je obyčajný súbor."
    (( (8#$(stat -f '%Lp' "${cutover_receipt}") & 8#077) == 0 )) || \
      die "Cutover receipt musí mať oprávnenie 600 alebo prísnejšie."
    jq -s -e '
        length == 2
        and .[0].receipt_schema_version == 1
        and .[0].status == "in_progress"
        and .[0].stage == "cutover_started"
        and .[1].receipt_schema_version == 1
        and .[1].status == "success"
        and .[1].stage == "cutover_complete"
        and .[0].release_version == .[1].release_version
        and .[0].image_id == .[1].image_id
        and .[0].build_context_sha256 == .[1].build_context_sha256
        and .[0].build_args_sha256 == .[1].build_args_sha256
        and .[0].sha256sums_sha256 == .[1].sha256sums_sha256
        and .[0].gate_snapshot_id == .[1].gate_snapshot_id
        and .[0].gate_report_sha256 == .[1].gate_report_sha256
        and .[0].gate_validated_at_utc == .[1].gate_validated_at_utc
        and .[1].dns_points_to_target == true
        and .[1].evidence_scope == "predeployment_gate_plus_local_https"
        and .[1].predeployment_source_write_freeze_active == true
        and .[1].predeployment_target_jobs_active == false
        and .[1].scheduler_enabled == false
        and .[1].compose_healthy == true
        and .[1].https_healthy == true
        and .[1].stack_removed == false
      ' "${cutover_receipt}" >/dev/null || \
      die "Cutover receipt nepotvrdzuje úspešný nemenný cutover."
    receipt_release="$(jq -sr '.[1].release_version' "${cutover_receipt}")"
    [[ "${cutover_receipt:t}" == "cutover-${receipt_release}.jsonl" ]] || \
      die "Cutover receipt názov nesedí s release verziou."
    [[ "$(management_api_source_freeze_state "${EXPECTED_SOURCE_REF}" "${SOURCE_SUPABASE_ACCESS_TOKEN}")" == on\|0 ]] || \
      die "Source už nie je potvrdene frozen on|0."
    refs=("${EXPECTED_TARGET_REF}")
    tokens=("${TARGET_SUPABASE_ACCESS_TOKEN}")
    ;;
esac

encoded_cleanup_targets="$(
  for (( index = 1; index <= ${#refs}; index++ )); do
    printf '%s\t%s\n' "${refs[$index]}" "${tokens[$index]}" | openssl base64 -A
    print
  done
)"
export MIGRATION_CLEANUP_TARGETS_B64="${encoded_cleanup_targets}"
if ! node --input-type=module -e '
  const projects = process.env.MIGRATION_CLEANUP_TARGETS_B64.split("\n").filter(Boolean).map((encoded) => {
    const [ref, token] = Buffer.from(encoded, "base64").toString("utf8").replace(/\n$/, "").split("\t");
    if (!/^[a-z0-9]{20}$/.test(ref) || !token) throw new Error("invalid cleanup target");
    return { ref, token };
  });
  let failed = false;
  for (const project of projects) {
    try {
      const response = await fetch(`https://api.supabase.com/v1/projects/${project.ref}/cli/login-role`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${project.token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!(response.ok || response.status === 404)) failed = true;
    } catch {
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
'; then
  {
    print -- "state=cleanup_partial_or_unconfirmed"
    print -- "checked_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    print -- "cleanup_state=retry_control_plane_delete_required"
  } >> "${MIGRATION_DB_CREDENTIAL_RECEIPT}"
  chmod 600 "${MIGRATION_DB_CREDENTIAL_RECEIPT}"
  die "Odvolanie DB rolí nie je potvrdené na oboch projektoch; secret zostal pre bezpečný retry."
fi
unset MIGRATION_CLEANUP_TARGETS_B64 encoded_cleanup_targets refs tokens

{
  print -- "state=revoked_${cleanup_mode#--revoke-after-}"
  print -- "revoked_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  print -- "cleanup_state=complete"
} >> "${MIGRATION_DB_CREDENTIAL_RECEIPT}"
chmod 600 "${MIGRATION_DB_CREDENTIAL_RECEIPT}"
rm -f -- "${SECRET_FILE}"
unset SOURCE_SUPABASE_ACCESS_TOKEN TARGET_SUPABASE_ACCESS_TOKEN
print -- "Dočasné CLI DB prístupy boli odvolané a lokálny migračný secret súbor odstránený."
