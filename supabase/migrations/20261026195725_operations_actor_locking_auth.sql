-- Authorization takes FOR SHARE locks through towing_authorize. PostgREST must
-- run this POST RPC in a read/write transaction, including membership-only users.
begin;
alter function app_private.operations_actor(uuid,uuid) volatile;
alter function public.motorist_operations_actor(uuid,uuid) volatile;
notify pgrst, 'reload schema';
commit;
