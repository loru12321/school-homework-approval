begin;

alter table if exists public.profiles
  alter column role set default 'teacher';

create or replace function public.normalize_auth_user_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  next_role text;
begin
  next_role := case
    when coalesce(new.raw_app_meta_data ->> 'role', '') = 'admin' then 'admin'
    when exists (
      select 1
      from public.profiles existing_profile
      where existing_profile.id = new.id
        and existing_profile.role = 'admin'
    ) then 'admin'
    else 'teacher'
  end;

  new.raw_user_meta_data := jsonb_set(
    coalesce(new.raw_user_meta_data, '{}'::jsonb),
    '{role}',
    to_jsonb(next_role),
    true
  );

  new.raw_app_meta_data := jsonb_set(
    coalesce(new.raw_app_meta_data, '{}'::jsonb),
    '{role}',
    to_jsonb(next_role),
    true
  );

  return new;
end;
$$;

comment on function public.normalize_auth_user_role() is
  '在 auth.users 写入阶段归一化角色，默认 teacher，仅允许现有管理员或 app_metadata.role=admin 保持管理员身份';

create or replace function public.secure_sync_profile_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  next_username text;
  next_full_name text;
  next_role text;
begin
  next_username := nullif(
    trim(coalesce(new.raw_user_meta_data ->> 'username', split_part(coalesce(new.email, ''), '@', 1))),
    ''
  );

  if next_username is null then
    next_username := split_part(coalesce(new.email, ''), '@', 1);
  end if;

  next_full_name := nullif(
    trim(coalesce(new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'full_name', next_username)),
    ''
  );

  next_role := case
    when coalesce(new.raw_app_meta_data ->> 'role', '') = 'admin' then 'admin'
    when exists (
      select 1
      from public.profiles existing_profile
      where existing_profile.id = new.id
        and existing_profile.role = 'admin'
    ) then 'admin'
    else 'teacher'
  end;

  insert into public.profiles as profile_target (id, username, full_name, role)
  values (new.id, next_username, coalesce(next_full_name, next_username), next_role)
  on conflict (id) do update
  set username = excluded.username,
      full_name = excluded.full_name,
      role = case
        when profile_target.role = 'admin' then 'admin'
        else excluded.role
      end;

  return new;
end;
$$;

comment on function public.secure_sync_profile_from_auth_user() is
  '同步 auth.users 到 profiles，并仅允许 app_metadata.role=admin 或已存在管理员继续保留管理员身份';

drop trigger if exists aa_secure_normalize_auth_user_role on auth.users;
drop trigger if exists zz_secure_sync_profile_from_auth_user on auth.users;

create trigger aa_secure_normalize_auth_user_role
before insert or update of email, raw_user_meta_data, raw_app_meta_data
on auth.users
for each row
execute function public.normalize_auth_user_role();

create trigger zz_secure_sync_profile_from_auth_user
after insert or update of email, raw_user_meta_data, raw_app_meta_data
on auth.users
for each row
execute function public.secure_sync_profile_from_auth_user();

insert into public.profiles (id, username, full_name, role)
select
  auth_user.id,
  coalesce(
    nullif(trim(auth_user.raw_user_meta_data ->> 'username'), ''),
    split_part(coalesce(auth_user.email, ''), '@', 1)
  ) as username,
  coalesce(
    nullif(trim(auth_user.raw_user_meta_data ->> 'name'), ''),
    nullif(trim(auth_user.raw_user_meta_data ->> 'full_name'), ''),
    coalesce(
      nullif(trim(auth_user.raw_user_meta_data ->> 'username'), ''),
      split_part(coalesce(auth_user.email, ''), '@', 1)
    )
  ) as full_name,
  case
    when coalesce(auth_user.raw_app_meta_data ->> 'role', '') = 'admin' then 'admin'
    else 'teacher'
  end as role
from auth.users as auth_user
where not exists (
  select 1
  from public.profiles as existing_profile
  where existing_profile.id = auth_user.id
);

update public.profiles as profile_target
set
  username = coalesce(
    nullif(trim(auth_user.raw_user_meta_data ->> 'username'), ''),
    split_part(coalesce(auth_user.email, ''), '@', 1)
  ),
  full_name = coalesce(
    nullif(trim(auth_user.raw_user_meta_data ->> 'name'), ''),
    nullif(trim(auth_user.raw_user_meta_data ->> 'full_name'), ''),
    coalesce(
      nullif(trim(auth_user.raw_user_meta_data ->> 'username'), ''),
      split_part(coalesce(auth_user.email, ''), '@', 1)
    )
  ),
  role = case
    when profile_target.role = 'admin' then 'admin'
    when coalesce(auth_user.raw_app_meta_data ->> 'role', '') = 'admin' then 'admin'
    else 'teacher'
  end
from auth.users as auth_user
where auth_user.id = profile_target.id;

update auth.users as auth_user
set
  raw_user_meta_data = jsonb_set(
    coalesce(auth_user.raw_user_meta_data, '{}'::jsonb),
    '{role}',
    to_jsonb(case when profile_target.role = 'admin' then 'admin' else 'teacher' end),
    true
  ),
  raw_app_meta_data = jsonb_set(
    coalesce(auth_user.raw_app_meta_data, '{}'::jsonb),
    '{role}',
    to_jsonb(case when profile_target.role = 'admin' then 'admin' else 'teacher' end),
    true
  )
from public.profiles as profile_target
where profile_target.id = auth_user.id;

commit;
