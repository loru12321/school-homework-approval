-- The cron request uses a random Vault secret; the Edge Function checks it
-- through a service-role-only RPC instead of requiring a separately copied env var.
create or replace function public.verify_retention_cron_secret(provided_secret text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'cleanup_expired_cloud_data_cron_secret'
      and decrypted_secret = provided_secret
  );
$$;

revoke all on function public.verify_retention_cron_secret(text) from public, anon, authenticated;
grant execute on function public.verify_retention_cron_secret(text) to service_role;

select vault.create_secret('https://bbsizrillgmkqwpkxxlj.supabase.co', 'project_url');
select vault.create_secret('sb_publishable_kLqJ-iREOI-bBhMzMebBUw_5rQVEikR', 'anon_key');
select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'cleanup_expired_cloud_data_cron_secret');

select public.configure_expired_cloud_data_cleanup_job();
