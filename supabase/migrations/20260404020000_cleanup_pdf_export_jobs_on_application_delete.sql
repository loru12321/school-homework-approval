begin;

create or replace function public.find_pdf_export_job_cleanup_candidates(target_application_ids bigint[])
returns table(
  job_id uuid,
  archive_path text,
  status text
)
language sql
security definer
set search_path = public
as $$
  with normalized_ids as (
    select array(
      select distinct value
      from unnest(coalesce(target_application_ids, '{}'::bigint[])) as value
    ) as ids
  )
  select distinct
    job.id as job_id,
    job.archive_path,
    job.status
  from public.pdf_export_jobs as job
  cross join normalized_ids
  where coalesce(array_length(normalized_ids.ids, 1), 0) > 0
    and jsonb_typeof(coalesce(job.items, '[]'::jsonb)) = 'array'
    and exists (
      select 1
      from jsonb_array_elements(coalesce(job.items, '[]'::jsonb)) as item
      where nullif(btrim(item ->> 'id'), '') is not null
        and (item ->> 'id') ~ '^[0-9]+$'
        and (item ->> 'id')::bigint = any(normalized_ids.ids)
    );
$$;

comment on function public.find_pdf_export_job_cleanup_candidates(bigint[]) is
  'Lists PDF export jobs and archive paths that reference deleted application ids.';

revoke all on function public.find_pdf_export_job_cleanup_candidates(bigint[]) from public;

do $$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'service_role'
  ) then
    grant execute on function public.find_pdf_export_job_cleanup_candidates(bigint[]) to service_role;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
