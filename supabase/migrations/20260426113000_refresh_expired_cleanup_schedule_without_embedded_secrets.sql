begin;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

create or replace function public.configure_expired_cloud_data_cleanup_job()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  job_name constant text := 'cleanup-expired-cloud-data-daily';
  cron_expression constant text := '20 19 * * *';
  project_url text;
  anon_key text;
  cron_secret text;
  existing_job record;
  scheduled_job_id bigint;
begin
  select decrypted_secret
  into project_url
  from vault.decrypted_secrets
  where name = 'project_url'
  order by created_at desc
  limit 1;

  select decrypted_secret
  into anon_key
  from vault.decrypted_secrets
  where name = 'anon_key'
  order by created_at desc
  limit 1;

  select decrypted_secret
  into cron_secret
  from vault.decrypted_secrets
  where name = 'cleanup_expired_cloud_data_cron_secret'
  order by created_at desc
  limit 1;

  for existing_job in
    select jobid
    from cron.job
    where jobname = job_name
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;

  if nullif(btrim(coalesce(project_url, '')), '') is null then
    return 'Skipped retention cleanup schedule: missing vault secret "project_url".';
  end if;

  if nullif(btrim(coalesce(anon_key, '')), '') is null then
    return 'Skipped retention cleanup schedule: missing vault secret "anon_key".';
  end if;

  if nullif(btrim(coalesce(cron_secret, '')), '') is null then
    return 'Skipped retention cleanup schedule: missing vault secret "cleanup_expired_cloud_data_cron_secret".';
  end if;

  select cron.schedule(
    job_name,
    cron_expression,
    $job$
    select
      net.http_post(
        url := (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'project_url'
          order by created_at desc
          limit 1
        ) || '/functions/v1/cleanup-expired-cloud-data',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'anon_key'
            order by created_at desc
            limit 1
          ),
          'x-retention-cron-secret', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'cleanup_expired_cloud_data_cron_secret'
            order by created_at desc
            limit 1
          )
        ),
        body := '{"source":"pg_cron"}'::jsonb
      ) as request_id;
    $job$
  )
  into scheduled_job_id;

  return format(
    'Scheduled %s with cron %s as job id %s (03:20 Asia/Shanghai / 19:20 UTC).',
    job_name,
    cron_expression,
    scheduled_job_id
  );
end;
$$;

comment on function public.configure_expired_cloud_data_cleanup_job() is
  'Creates or refreshes the daily cron job that invokes the cleanup-expired-cloud-data Edge Function without embedding secrets in cron.job.';

select public.configure_expired_cloud_data_cleanup_job();

notify pgrst, 'reload schema';

commit;
