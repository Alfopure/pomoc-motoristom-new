#!/bin/zsh

set -euo pipefail
umask 077

readonly RCLONE_IMAGE="rclone/rclone:1.71.2"
readonly POSTGRES_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.143"
readonly EXPECTED_SOURCE_REF="jcwbiulwuwyrnmzjjbgr"
readonly EXPECTED_TARGET_REF="sjcsrygkkmersoczpunh"
readonly ROOT_DIR="${0:A:h:h:h}"
readonly SECRET_FILE="${ROOT_DIR}/.context/secrets/supabase-dispatch-migration.env"
readonly SNAPSHOT_ROOT="${ROOT_DIR}/.context/migration/snapshots"
readonly FREEZE_ROOT="${ROOT_DIR}/.context/migration/source-freeze"
readonly LOG_ROOT="${ROOT_DIR}/.context/migration/logs"
readonly REPORT_ROOT="${ROOT_DIR}/.context/migration/validation"
readonly LIBPQ_HELPER="${ROOT_DIR}/deploy/supabase/libpq-credentials.zsh"
readonly MANAGEMENT_API_HELPER="${ROOT_DIR}/deploy/supabase/management-api-readonly.zsh"
readonly CONTINUITY_POLICY="${ROOT_DIR}/deploy/supabase/live-target-continuity-policy.json"
readonly CONTINUITY_ROOT="${ROOT_DIR}/.context/migration/continuity"
readonly LIST_DIGEST_HELPER="${ROOT_DIR}/deploy/bin/digest-private-path-list.mjs"
readonly PRIVATE_CAPTURE_HELPER="${ROOT_DIR}/deploy/bin/capture-private-evidence.py"
readonly WATERMARK_RESOLVER="${ROOT_DIR}/deploy/bin/resolve-live-watermark-anchor.mjs"

source "${LIBPQ_HELPER}"
source "${MANAGEMENT_API_HELPER}"

die() {
  print -u2 -- "$1"
  exit 1
}

rclone_run() {
  migration_docker_run --rm \
    --mount "type=bind,source=${rclone_config},target=/config/rclone/rclone.conf,readonly" \
    --mount "type=bind,source=${storage_work_dir},target=/work" \
    "${RCLONE_IMAGE}" "$@"
}

if [[ "$#" -ne 2 ]]; then
  die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ --copy-storage|--validate-storage-only"
fi
case "$2" in
  --copy-storage) storage_operation=copy ;;
  --validate-storage-only) storage_operation=validate ;;
  *) die "Použitie: ${0:t} YYYYMMDDTHHMMSSZ --copy-storage|--validate-storage-only" ;;
esac
if [[ "${storage_operation}" == copy ]]; then
  die "Live target už obsluhuje Rentals; --copy-storage je zakázané. Použi iba --validate-storage-only."
fi

snapshot_id="$1"
[[ "${snapshot_id}" =~ '^[0-9]{8}T[0-9]{6}Z$' ]] || \
  die "Snapshot ID musí mať tvar YYYYMMDDTHHMMSSZ."

[[ -r "${CONTINUITY_POLICY}" && "$(jq -r '.snapshotId' "${CONTINUITY_POLICY}")" == "${snapshot_id}" ]] || \
  die "Chýba platná live-target continuity policy."
live_bucket="$(jq -er '.storage.onlyLiveGrowthBucket' "${CONTINUITY_POLICY}")" || \
  die "Continuity policy nemá live Storage bucket."
typeset -a continuity_anchors watermark_anchors storage_anchor_dirs
continuity_anchors=("${CONTINUITY_ROOT}"/anchor-${snapshot_id}-*.json(N))
watermark_anchors=("${CONTINUITY_ROOT}"/live-watermark-${snapshot_id}-*.json(N))
storage_anchor_dirs=("${CONTINUITY_ROOT}"/live-storage-${snapshot_id}-*(N/))
(( ${#continuity_anchors[@]} == 1 )) || die "Očakáva sa práve jeden continuity anchor."
(( ${#storage_anchor_dirs[@]} == 1 )) || die "Očakáva sa práve jeden live Storage anchor."
continuity_anchor="${continuity_anchors[1]}"
watermark_resolution="$(node "${WATERMARK_RESOLVER}" \
  "${CONTINUITY_POLICY}" \
  "${continuity_anchor}" \
  "${watermark_anchors[@]}")" || die "Live watermark reťazec je neplatný."
watermark_anchor="$(jq -er '.currentPath' <<< "${watermark_resolution}")" || die "Live watermark resolver nevrátil current path."
root_watermark_sha256="$(jq -er '.rootSha256' <<< "${watermark_resolution}")" || die "Live watermark resolver nevrátil root watermark hash."
storage_anchor_dir="${storage_anchor_dirs[1]%/}"
storage_anchor_manifest="${storage_anchor_dir}/manifest.json"
storage_anchor_names="${storage_anchor_dir}/target-only.txt"
storage_anchor_content="${storage_anchor_dir}/target-only.sha256"
(( (8#$(stat -f '%Lp' "${continuity_anchor}") & 8#077) == 0 )) || die "Continuity anchor musí byť private."
(( (8#$(stat -f '%Lp' "${watermark_anchor}") & 8#077) == 0 )) || die "Live watermark anchor musí byť private."
(( (8#$(stat -f '%Lp' "${storage_anchor_dir}") & 8#077) == 0 )) || die "Live Storage anchor adresár musí byť private."
for anchor_file in "${storage_anchor_manifest}" "${storage_anchor_names}" "${storage_anchor_content}"; do
  [[ -f "${anchor_file}" && ! -L "${anchor_file}" ]] || die "Live Storage anchor nie je úplný."
  (( (8#$(stat -f '%Lp' "${anchor_file}") & 8#077) == 0 )) || die "Live Storage anchor súbor musí byť private."
  [[ "$(stat -f '%l' "${anchor_file}")" == 1 ]] || die "Live Storage anchor súbor nesmie mať hardlinky."
done
continuity_policy_sha256="$(shasum -a 256 "${CONTINUITY_POLICY}" | awk '{print $1}')"
root_policy_sha256="$(jq -er '.rootPolicySha256 | select(test("^[0-9a-f]{64}$"))' <<< "${watermark_resolution}")" || \
  die "Live watermark resolver nevrátil root policy hash."
continuity_anchor_sha256="$(shasum -a 256 "${continuity_anchor}" | awk '{print $1}')"
watermark_anchor_sha256="$(shasum -a 256 "${watermark_anchor}" | awk '{print $1}')"
storage_anchor_sha256="$(shasum -a 256 "${storage_anchor_manifest}" | awk '{print $1}')"
jq -e --arg snapshot_id "${snapshot_id}" --arg policy_sha256 "${root_policy_sha256}" '
  .snapshotId == $snapshot_id
  and .sourceFrozen == true
  and .targetRewindForbidden == true
  and .evidence.continuityPolicySha256 == $policy_sha256
' "${continuity_anchor}" >/dev/null || die "Continuity anchor nesedí s policy."
jq -e --arg snapshot_id "${snapshot_id}" --arg target_ref "${EXPECTED_TARGET_REF}" \
  --arg policy_sha256 "${continuity_policy_sha256}" --arg base_sha256 "${continuity_anchor_sha256}" '
  .snapshotId == $snapshot_id
  and .targetProjectRef == $target_ref
  and .continuityPolicySha256 == $policy_sha256
  and .baseContinuityAnchorSha256 == $base_sha256
' "${watermark_anchor}" >/dev/null || die "Live watermark anchor nesedí s continuity trust root."
jq -e \
  --arg snapshot_id "${snapshot_id}" \
  --arg source_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_ref "${EXPECTED_TARGET_REF}" \
  --arg policy_sha256 "${root_policy_sha256}" \
  --arg base_sha256 "${continuity_anchor_sha256}" \
  --arg watermark_sha256 "${root_watermark_sha256}" \
  --arg names_sha256 "$(shasum -a 256 "${storage_anchor_names}" | awk '{print $1}')" \
  --arg content_sha256 "$(shasum -a 256 "${storage_anchor_content}" | awk '{print $1}')" '
  .schemaVersion == 1
  and .snapshotId == $snapshot_id
  and .sourceProjectRef == $source_ref
  and .targetProjectRef == $target_ref
  and .continuityPolicySha256 == $policy_sha256
  and .baseContinuityAnchorSha256 == $base_sha256
  and .liveWatermarkAnchorSha256 == $watermark_sha256
  and .targetOnlyNamesSha256 == $names_sha256
  and .targetOnlyContentCatalogSha256 == $content_sha256
  and (.targetOnlyPayloadCount | type) == "number"
  and .targetOnlyPayloadCount >= 156
  and .sourceBaselineContentVerified == true
' "${storage_anchor_manifest}" >/dev/null || die "Live Storage anchor nesedí s continuity trust root."

[[ -r "${SECRET_FILE}" ]] || \
  die "Chýba ${SECRET_FILE}. Najprv spusti capture-migration-credentials.zsh so Storage údajmi."
if (( (8#$(stat -f '%Lp' "${SECRET_FILE}") & 8#077) != 0 )); then
  die "Secret súbor musí mať oprávnenie 600 alebo prísnejšie."
fi

source "${SECRET_FILE}"
: "${SOURCE_PROJECT_REF:?SOURCE_PROJECT_REF chýba}"
: "${TARGET_PROJECT_REF:?TARGET_PROJECT_REF chýba}"
: "${MIGRATION_ARCHIVE_PASSPHRASE:?MIGRATION_ARCHIVE_PASSPHRASE chýba}"
: "${SOURCE_STORAGE_ENDPOINT:?SOURCE_STORAGE_ENDPOINT chýba}"
: "${SOURCE_STORAGE_REGION:?SOURCE_STORAGE_REGION chýba}"
: "${SOURCE_STORAGE_ACCESS_KEY_ID:?SOURCE_STORAGE_ACCESS_KEY_ID chýba}"
: "${SOURCE_STORAGE_SECRET_ACCESS_KEY:?SOURCE_STORAGE_SECRET_ACCESS_KEY chýba}"
: "${TARGET_STORAGE_ENDPOINT:?TARGET_STORAGE_ENDPOINT chýba}"
: "${TARGET_STORAGE_REGION:?TARGET_STORAGE_REGION chýba}"
: "${TARGET_STORAGE_ACCESS_KEY_ID:?TARGET_STORAGE_ACCESS_KEY_ID chýba}"
: "${TARGET_STORAGE_SECRET_ACCESS_KEY:?TARGET_STORAGE_SECRET_ACCESS_KEY chýba}"
: "${TARGET_STORAGE_AUTH_MODE:?TARGET_STORAGE_AUTH_MODE chýba}"
: "${TARGET_SUPABASE_ACCESS_TOKEN:?TARGET_SUPABASE_ACCESS_TOKEN chýba}"
TARGET_STORAGE_SESSION_TOKEN="${TARGET_STORAGE_SESSION_TOKEN:-}"
export MIGRATION_ARCHIVE_PASSPHRASE

[[ "${SOURCE_PROJECT_REF}" == "${EXPECTED_SOURCE_REF}" ]] || die "Source project ref nesedí."
[[ "${TARGET_PROJECT_REF}" == "${EXPECTED_TARGET_REF}" ]] || die "Target project ref nesedí."
source_validation_mode="${SOURCE_DB_VALIDATION_MODE:-database_url}"
case "${source_validation_mode}" in
  management_api_read_only)
    : "${SOURCE_SUPABASE_ACCESS_TOKEN:?SOURCE_SUPABASE_ACCESS_TOKEN chýba}"
    ;;
  database_url)
    : "${SOURCE_DB_URL:?SOURCE_DB_URL chýba}"
    libpq_url_matches_project \
      "${SOURCE_DB_URL}" \
      "${EXPECTED_SOURCE_REF}" \
      "${MIGRATION_LOCAL_REHEARSAL:-0}" || \
      die "Source DB URL nepatrí očakávanému source projektu."
    ;;
  *) die "Nepodporovaný SOURCE_DB_VALIDATION_MODE; Storage operácia je zakázaná." ;;
esac
[[ "${SOURCE_STORAGE_ENDPOINT}" == "https://${EXPECTED_SOURCE_REF}.storage.supabase.co/storage/v1/s3" ]] || \
  die "Source Storage endpoint nesedí."
[[ "${TARGET_STORAGE_ENDPOINT}" == "https://${EXPECTED_TARGET_REF}.storage.supabase.co/storage/v1/s3" ]] || \
  die "Target Storage endpoint nesedí."
case "${TARGET_STORAGE_AUTH_MODE}" in
  generated_pair)
    [[ -z "${TARGET_STORAGE_SESSION_TOKEN}" ]] || \
      die "Target generated S3 pár nesmie mať session token."
    ;;
  session_token)
    [[ -n "${TARGET_STORAGE_SESSION_TOKEN}" ]] || \
      die "Target session-token režim vyžaduje session token."
    [[ "${TARGET_STORAGE_ACCESS_KEY_ID}" == "${EXPECTED_TARGET_REF}" ]] || \
      die "Target session-token access key musí byť project ref."
    ;;
  *) die "TARGET_STORAGE_AUTH_MODE musí byť generated_pair alebo session_token." ;;
esac

snapshot_dir="${SNAPSHOT_ROOT}/${snapshot_id}"
manifest_file="${snapshot_dir}/MANIFEST"
inventory_file="${snapshot_dir}/inventory.tsv.enc"
[[ -r "${manifest_file}" && -s "${inventory_file}" ]] || \
  die "Snapshot nemá manifest alebo šifrovaný inventár."

freeze_receipt="${FREEZE_ROOT}/${snapshot_id}.env"
[[ -r "${freeze_receipt}" ]] || die "Chýba source freeze receipt pre tento snapshot."
if (( (8#$(stat -f '%Lp' "${freeze_receipt}") & 8#077) != 0 )); then
  die "Source freeze receipt musí mať oprávnenie 600 alebo prísnejšie."
fi
[[ "$(sed -n 's/^state=//p' "${freeze_receipt}")" == frozen ]] || \
  die "Source freeze receipt už nie je v stave frozen."
manifest_freeze_hash="$(sed -n 's/^source_freeze_receipt_sha256=//p' "${manifest_file}")"
[[ -n "${manifest_freeze_hash}" ]] || die "Snapshot manifest nemá source freeze hash."
[[ "$(shasum -a 256 "${freeze_receipt}" | awk '{print $1}')" == "${manifest_freeze_hash}" ]] || \
  die "Source freeze receipt sa od exportu zmenil."

if [[ "${source_validation_mode}" == management_api_read_only ]]; then
  source_freeze_state="$(
    management_api_source_freeze_state \
      "${EXPECTED_SOURCE_REF}" \
      "${SOURCE_SUPABASE_ACCESS_TOKEN}"
  )" || die "Source write-freeze sa nepodarilo cez read-only Management API overiť."
else
  if ! libpq_prepare_credentials \
    "${SOURCE_DB_URL}" \
    "${ROOT_DIR}/.context/secrets" \
    source-freeze-storage; then
    die "Source DB URL sa nepodarilo bezpečne rozdeliť na pgpass a URL bez hesla."
  fi
  trap libpq_cleanup_credentials EXIT INT TERM
  source_freeze_state="$(
    print -- "select pg_catalog.current_setting('default_transaction_read_only')
      || '|' || case
        when pg_catalog.to_regclass('cron.job') is null then '0'
        else (pg_catalog.xpath(
          '/row/count/text()',
          pg_catalog.query_to_xml('select count(*) as count from cron.job where active', false, true, '')
        ))[1]::text
      end;" | migration_docker_run --rm -i \
        --mount "type=bind,source=${LIBPQ_PGPASS_FILE},target=/run/secrets/pgpass,readonly" \
        --env PGPASSFILE=/run/secrets/pgpass \
        "${POSTGRES_IMAGE}" \
        psql --no-psqlrc --no-align --tuples-only --quiet \
          --set ON_ERROR_STOP=1 "${LIBPQ_SAFE_URL}" | tr -d '[:space:]'
  )" || die "Source write-freeze sa nepodarilo overiť."
  libpq_cleanup_credentials
  trap - EXIT INT TERM
fi
[[ "${source_freeze_state}" == "on|0" ]] || \
  die "Source už nie je read-only alebo má aktívny cron; Storage copy bol zastavený."

expected_inventory_hash="$(awk -v file='inventory.tsv.enc' '$2 == file { print $1; exit }' "${manifest_file}")"
actual_inventory_hash="$(shasum -a 256 "${inventory_file}" | awk '{print $1}')"
[[ -n "${expected_inventory_hash}" && "${actual_inventory_hash}" == "${expected_inventory_hash}" ]] || \
  die "Šifrovaný inventár má neplatný kontrolný súčet."

source_inventory="$(
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "${inventory_file}" \
    -pass env:MIGRATION_ARCHIVE_PASSPHRASE
)"
baseline_storage="$(print -r -- "${source_inventory}" | sed -n 's/^storage_buckets=//p')"
jq -e 'type == "object"' <<< "${baseline_storage}" >/dev/null || \
  die "Snapshot Storage baseline nie je platný."

typeset -a buckets
buckets=("${(@f)$(jq -r 'keys[]' <<< "${baseline_storage}")}")
(( ${#buckets[@]} > 0 )) || die "Snapshot neobsahuje žiadne Storage buckety."

storage_work_dir="$(mktemp -d "${ROOT_DIR}/.context/secrets/.storage-validation.XXXXXX")"
chmod 700 "${storage_work_dir}"
rclone_config="${storage_work_dir}/rclone.conf"
trap 'rm -rf -- "${storage_work_dir}"' EXIT INT TERM

{
  print -- '[source]'
  print -- 'type = s3'
  print -- 'provider = Other'
  print -- 'env_auth = false'
  printf 'access_key_id = %s\n' "${SOURCE_STORAGE_ACCESS_KEY_ID}"
  printf 'secret_access_key = %s\n' "${SOURCE_STORAGE_SECRET_ACCESS_KEY}"
  printf 'endpoint = %s\n' "${SOURCE_STORAGE_ENDPOINT}"
  printf 'region = %s\n' "${SOURCE_STORAGE_REGION}"
  print -- 'acl = private'
  print -- 'no_check_bucket = true'
  print
  print -- '[target]'
  print -- 'type = s3'
  print -- 'provider = Other'
  print -- 'env_auth = false'
  printf 'access_key_id = %s\n' "${TARGET_STORAGE_ACCESS_KEY_ID}"
  printf 'secret_access_key = %s\n' "${TARGET_STORAGE_SECRET_ACCESS_KEY}"
  if [[ "${TARGET_STORAGE_AUTH_MODE}" == session_token ]]; then
    printf 'session_token = %s\n' "${TARGET_STORAGE_SESSION_TOKEN}"
  fi
  printf 'endpoint = %s\n' "${TARGET_STORAGE_ENDPOINT}"
  printf 'region = %s\n' "${TARGET_STORAGE_REGION}"
  print -- 'acl = private'
  print -- 'no_check_bucket = true'
} > "${rclone_config}"
chmod 600 "${rclone_config}"

mkdir -p "${LOG_ROOT}" "${REPORT_ROOT}"
chmod 700 "${LOG_ROOT}" "${REPORT_ROOT}"
storage_log="${LOG_ROOT}/storage-${snapshot_id}.log"
: > "${storage_log}"
chmod 600 "${storage_log}"

storage_check() {
  if [[ "${storage_operation}" == validate ]]; then
    rclone_run "$@" >/dev/null 2>&1
  else
    rclone_run "$@" >> "${storage_log}" 2>&1
  fi
}

typeset -A bucket_content_matches bucket_reverse_matches
print -- "Overujem obsah každého source objektu na live targete bez zápisu alebo mazania..."
for bucket in "${buckets[@]}"; do
  bucket_content_matches[$bucket]=true
  bucket_reverse_matches[$bucket]=true
  if ! storage_check check "source:${bucket}" "target:${bucket}" \
    --one-way --download --checkers 8; then
    bucket_content_matches[$bucket]=false
  fi
  if [[ "${bucket}" != "${live_bucket}" ]] && ! storage_check check "target:${bucket}" "source:${bucket}" \
    --one-way --size-only --checkers 8; then
    bucket_reverse_matches[$bucket]=false
  fi
done

live_source_paths="${storage_work_dir}/live-source.txt"
live_target_paths="${storage_work_dir}/live-target.txt"
live_target_only_paths="${storage_work_dir}/live-target-only.txt"
anchored_paths="${storage_work_dir}/anchored-target-only.txt"
anchored_content="${storage_work_dir}/anchored-target-only.sha256"
current_anchored_content="${storage_work_dir}/current-anchored-target-only.sha256"
rclone_run lsf --files-only --recursive "source:${live_bucket}" > "${live_source_paths}"
rclone_run lsf --files-only --recursive "target:${live_bucket}" > "${live_target_paths}"
LC_ALL=C sort -u "${live_source_paths}" -o "${live_source_paths}"
LC_ALL=C sort -u "${live_target_paths}" -o "${live_target_paths}"
comm -13 "${live_source_paths}" "${live_target_paths}" > "${live_target_only_paths}"
chmod 600 "${live_source_paths}" "${live_target_paths}" "${live_target_only_paths}"
current_target_only_summary="$(node "${LIST_DIGEST_HELPER}" "${live_target_only_paths}")" || \
  die "Aktuálny target-only Storage katalóg je neplatný."
current_target_only_count="$(jq -er '.count' <<< "${current_target_only_summary}")"
current_target_only_digest="$(jq -er '.sha256' <<< "${current_target_only_summary}")"

python3 "${PRIVATE_CAPTURE_HELPER}" "${storage_anchor_names}" "${anchored_paths}"
python3 "${PRIVATE_CAPTURE_HELPER}" "${storage_anchor_content}" "${anchored_content}"
anchored_summary="$(node "${LIST_DIGEST_HELPER}" "${anchored_paths}")" || \
  die "Ukotvený target-only Storage katalóg je neplatný."
anchored_count="$(jq -er '.count' <<< "${anchored_summary}")"
[[ "${anchored_count}" == "$(jq -r '.targetOnlyPayloadCount' "${storage_anchor_manifest}")" ]] || \
  die "Počet položiek v live Storage anchor nesedí."

anchored_live_content_matches=true
missing_anchored_count="$(comm -23 "${anchored_paths}" "${live_target_only_paths}" | wc -l | tr -d ' ')"
if (( missing_anchored_count > 0 )); then
  anchored_live_content_matches=false
elif ! rclone_run hashsum SHA-256 "target:${live_bucket}" --download \
  --files-from /work/anchored-target-only.txt > "${current_anchored_content}"; then
  anchored_live_content_matches=false
else
  LC_ALL=C sort -u "${current_anchored_content}" -o "${current_anchored_content}"
  chmod 600 "${current_anchored_content}"
  cmp -s "${anchored_content}" "${current_anchored_content}" || anchored_live_content_matches=false
fi

snapshot_cutoff="${snapshot_id[1,4]}-${snapshot_id[5,6]}-${snapshot_id[7,8]}T${snapshot_id[10,11]}:${snapshot_id[12,13]}:${snapshot_id[14,15]}Z"
target_live_metadata="$(
  print -r -- "select pg_catalog.jsonb_build_object(
    'count', count(*),
    'digest', pg_catalog.encode(
      extensions.digest(
        coalesce(pg_catalog.string_agg(name, E'\\n' order by name collate \"C\"), ''),
        'sha256'
      ),
      'hex'
    )
  ) as continuity
  from storage.objects
  where bucket_id = '${live_bucket}'
    and created_at > timestamptz '${snapshot_cutoff}';" |
    management_api_readonly_json "${EXPECTED_TARGET_REF}" "${TARGET_SUPABASE_ACCESS_TOKEN}"
)" || die "Target Storage metadata sa nepodarilo read-only overiť."
if jq -e \
  --argjson count "${current_target_only_count}" \
  --arg digest "${current_target_only_digest}" '
    length == 1
    and (.[0].continuity.count | tonumber) == $count
    and .[0].continuity.digest == $digest
  ' <<< "${target_live_metadata}" >/dev/null; then
  target_only_keyset_matches_database=true
else
  target_only_keyset_matches_database=false
fi

# Re-list and re-check remote hashes after the full payload pass. This closes
# the interval in which a source object could otherwise change after it was
# downloaded but before the aggregate report was written.
for bucket in "${buckets[@]}"; do
  if ! storage_check check "source:${bucket}" "target:${bucket}" --one-way --checkers 16; then
    bucket_content_matches[$bucket]=false
  fi
done

bucket_reports='{}'
storage_status="pass"
for bucket in "${buckets[@]}"; do
  source_size="$(rclone_run size --json "source:${bucket}" 2>> "${storage_log}")" || \
    die "Agregácia source Storage zlyhala pre ${bucket}."
  target_size="$(rclone_run size --json "target:${bucket}" 2>> "${storage_log}")" || \
    die "Agregácia target Storage zlyhala pre ${bucket}."
  baseline_bucket="$(jq -c --arg bucket "${bucket}" '.[$bucket]' <<< "${baseline_storage}")"
  content_matches="${bucket_content_matches[$bucket]}"
  reverse_matches="${bucket_reverse_matches[$bucket]}"
  live_growth_allowed=false
  [[ "${bucket}" == "${live_bucket}" ]] && live_growth_allowed=true

  bucket_ok="$(jq -n \
    --argjson baseline "${baseline_bucket}" \
    --argjson source "${source_size}" \
    --argjson target "${target_size}" \
    --argjson content_matches "${content_matches}" \
    --argjson reverse_matches "${reverse_matches}" \
    --argjson live_growth_allowed "${live_growth_allowed}" \
    --argjson target_only_count "${current_target_only_count}" \
    --argjson keyset_matches_database "${target_only_keyset_matches_database}" \
    --argjson anchored_content_matches "${anchored_live_content_matches}" \
    '$baseline.objects == $source.count and
     $baseline.bytes == $source.bytes and
     (if $live_growth_allowed then
        $target.count >= $source.count and $target.bytes >= $source.bytes
      else
        $source.count == $target.count and $source.bytes == $target.bytes and $reverse_matches
      end) and
     (if $live_growth_allowed then
        $target.count - $source.count == $target_only_count
        and $keyset_matches_database
        and $anchored_content_matches
      else true end) and
     $content_matches')"
  [[ "${bucket_ok}" == true ]] || storage_status="fail"

  bucket_reports="$(jq -cn \
    --argjson reports "${bucket_reports}" \
    --arg bucket "${bucket}" \
    --argjson baseline "${baseline_bucket}" \
    --argjson source "${source_size}" \
    --argjson target "${target_size}" \
    --argjson ok "${bucket_ok}" \
    --argjson live_growth_allowed "${live_growth_allowed}" \
    --argjson keyset_matches_database "${target_only_keyset_matches_database}" \
    --argjson anchored_content_matches "${anchored_live_content_matches}" \
    '$reports + {($bucket): {
      baseline: {count: $baseline.objects, bytes: $baseline.bytes},
      source: {count: $source.count, bytes: $source.bytes},
      target: {count: $target.count, bytes: $target.bytes},
      target_extra_count: ($target.count - $source.count),
      target_extra_bytes: ($target.bytes - $source.bytes),
      live_growth_allowed: $live_growth_allowed,
      target_only_keyset_matches_database: (if $live_growth_allowed then $keyset_matches_database else null end),
      anchored_live_content_matches: (if $live_growth_allowed then $anchored_content_matches else null end),
      matches: $ok
    }}')"
done

report_file="${REPORT_ROOT}/storage-${snapshot_id}.json"
jq -n \
  --arg snapshot_id "${snapshot_id}" \
  --arg source_project_ref "${EXPECTED_SOURCE_REF}" \
  --arg target_project_ref "${EXPECTED_TARGET_REF}" \
  --arg validated_at_utc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg source_validation_mode "${source_validation_mode}" \
  --arg storage_operation "${storage_operation}" \
  --arg status "${storage_status}" \
  --arg live_bucket "${live_bucket}" \
  --arg continuity_policy_sha256 "${continuity_policy_sha256}" \
  --arg continuity_anchor_sha256 "${continuity_anchor_sha256}" \
  --arg live_watermark_anchor_sha256 "${watermark_anchor_sha256}" \
  --arg live_storage_anchor_sha256 "${storage_anchor_sha256}" \
  --argjson target_only_keyset_matches_database "${target_only_keyset_matches_database}" \
  --argjson anchored_live_content_matches "${anchored_live_content_matches}" \
  --argjson target_only_payload_count "${current_target_only_count}" \
  --argjson buckets "${bucket_reports}" \
  '{
    snapshot_id: $snapshot_id,
    source_project_ref: $source_project_ref,
    target_project_ref: $target_project_ref,
    validated_at_utc: $validated_at_utc,
    source_validation_mode: $source_validation_mode,
    storage_operation: $storage_operation,
    privacy: "Aggregate bucket counts and bytes only; no object names or credentials.",
    storage_payload_status: $status,
    continuity_status: (if $status == "pass" then "pass_continuity" else "fail" end),
    live_growth_bucket: $live_bucket,
    continuity_policy_sha256: $continuity_policy_sha256,
    continuity_anchor_sha256: $continuity_anchor_sha256,
    live_watermark_anchor_sha256: $live_watermark_anchor_sha256,
    live_storage_anchor_sha256: $live_storage_anchor_sha256,
    target_only_keyset_matches_database: $target_only_keyset_matches_database,
    anchored_live_content_matches: $anchored_live_content_matches,
    target_only_payload_count: $target_only_payload_count,
    buckets: $buckets,
    source_deleted: false,
    source_write_freeze_active: true,
    cutover_status: "blocked_pending_config_and_application_validation"
  }' > "${report_file}"
chmod 600 "${report_file}"

unset SOURCE_STORAGE_ACCESS_KEY_ID SOURCE_STORAGE_SECRET_ACCESS_KEY SOURCE_STORAGE_REGION
unset TARGET_STORAGE_ACCESS_KEY_ID TARGET_STORAGE_SECRET_ACCESS_KEY TARGET_STORAGE_REGION
unset TARGET_STORAGE_SESSION_TOKEN TARGET_STORAGE_AUTH_MODE
unset MIGRATION_ARCHIVE_PASSPHRASE SOURCE_DB_URL SOURCE_SUPABASE_ACCESS_TOKEN TARGET_SUPABASE_ACCESS_TOKEN

if [[ "${storage_status}" != pass ]]; then
  die "Storage sa nezhoduje so snapshot baseline; cutover je zakázaný. Report: .context/migration/validation/${report_file:t}"
fi

if [[ "${storage_operation}" == copy ]]; then
  print -- "Storage copy a obsahová validácia prešli. Source nebol zmenený ani zmazaný."
else
  print -- "Read-only Storage obsahová validácia prešla. Source ani target neboli zmenené."
fi
print -- "Report: .context/migration/validation/${report_file:t}"
