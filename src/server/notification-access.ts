/** Service-role queries need an explicit audience predicate even though RLS
 * protects direct browser reads. Missing/malformed identity only sees the
 * explicitly shared historical team rows, never private recipients.
 */
export function notificationAudienceFilter(profileId?: string | null) {
  return profileId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId)
    ? `visibility.eq.team,and(visibility.eq.private,recipient_profile_id.eq.${profileId})`
    : "visibility.eq.team";
}
