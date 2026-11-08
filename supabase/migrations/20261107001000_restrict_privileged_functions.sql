-- Restrict privileged RPCs after restoring historical migrations.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn.signature);
    execute format('grant execute on function %s to service_role', fn.signature);
    if fn.proname in (
      'admin_change_application_status',
      'admin_bulk_change_application_status',
      'admin_delete_rejected_application',
      'admin_bulk_delete_rejected_applications'
    ) then
      execute format('grant execute on function %s to authenticated', fn.signature);
    end if;
  end loop;
end;
$$;

alter function public.set_row_updated_at() set search_path = '';
