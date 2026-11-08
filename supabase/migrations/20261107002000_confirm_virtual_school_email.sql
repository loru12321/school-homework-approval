-- The app converts usernames to virtual @school.com email addresses.
-- Those addresses cannot receive Supabase confirmation messages.
create or replace function public.confirm_virtual_school_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.email ~* '^[a-z0-9_]{3,20}@school\.com$' then
    new.email_confirmed_at := coalesce(new.email_confirmed_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists ab_confirm_virtual_school_email on auth.users;
create trigger ab_confirm_virtual_school_email
before insert on auth.users
for each row execute function public.confirm_virtual_school_email();

revoke all on function public.confirm_virtual_school_email() from public, anon, authenticated;
