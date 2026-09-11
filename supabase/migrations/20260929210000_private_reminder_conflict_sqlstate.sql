-- The reminder insert trigger rejects stale business state, not serialization.
-- Preserve its body, locks, signature, SECURITY DEFINER, search_path and ACLs.
-- Audited against the copy on 2026-09-11; refuse any other definition.
begin;
do $migration$
declare
  current_definition text;
begin
  select pg_get_functiondef(to_regprocedure('app_private.motorist_validate_reminder_delivery()'))
    into current_definition;
  if current_definition is null
    or md5(replace(current_definition, '''PT409''', '''40001''')) <> '2e89c224a761d506da56da04f32896f8' then
    raise exception 'Reminder conflict migration refused: missing or drifted trigger function';
  end if;
  execute replace(current_definition, '''40001''', '''PT409''');
end;
$migration$;
commit;
