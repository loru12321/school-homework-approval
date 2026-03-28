begin;

create or replace function public.nullif_placeholder_name(input_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when input_value is null then null
    when nullif(btrim(input_value), '') is null then null
    when nullif(replace(replace(btrim(input_value), '?', ''), '？', ''), '') is null then null
    else btrim(input_value)
  end;
$$;

comment on function public.nullif_placeholder_name(text) is
  '将空字符串或全问号占位名规范化为 null，避免显示名污染审批人与日志字段';

revoke all on function public.nullif_placeholder_name(text) from public;

update public.profiles
set full_name = coalesce(
  public.nullif_placeholder_name(full_name),
  public.nullif_placeholder_name(username),
  full_name
)
where public.nullif_placeholder_name(full_name) is null
  and nullif(btrim(coalesce(full_name, '')), '') is not null;

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

  next_full_name := coalesce(
    public.nullif_placeholder_name(new.raw_user_meta_data ->> 'name'),
    public.nullif_placeholder_name(new.raw_user_meta_data ->> 'full_name'),
    next_username
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
  values (new.id, next_username, next_full_name, next_role)
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

update public.profiles as profile_target
set
  username = coalesce(
    nullif(trim(auth_user.raw_user_meta_data ->> 'username'), ''),
    split_part(coalesce(auth_user.email, ''), '@', 1)
  ),
  full_name = coalesce(
    public.nullif_placeholder_name(auth_user.raw_user_meta_data ->> 'name'),
    public.nullif_placeholder_name(auth_user.raw_user_meta_data ->> 'full_name'),
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

create or replace function public.admin_change_application_status(
  target_application_id bigint,
  target_status text,
  target_approval_time timestamptz default null,
  target_rejection_reason text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_role text;
  requester_name text;
  normalized_status text;
  normalized_reason text;
  normalized_time timestamptz;
  updated_app public.applications%rowtype;
begin
  select
    coalesce(role, 'teacher'),
    coalesce(
      public.nullif_placeholder_name(full_name),
      public.nullif_placeholder_name(username),
      '未命名用户'
    )
  into requester_role, requester_name
  from public.profiles
  where id = auth.uid();

  requester_role := coalesce(requester_role, 'teacher');
  requester_name := coalesce(public.nullif_placeholder_name(requester_name), '未命名用户');
  normalized_status := btrim(coalesce(target_status, ''));

  if requester_role <> 'admin' then
    raise exception '只有管理员可以更新审批状态';
  end if;

  if normalized_status not in ('已通过', '已驳回') then
    raise exception '仅支持通过或驳回待审批记录';
  end if;

  normalized_time := coalesce(target_approval_time, timezone('utc', now()));

  if normalized_status = '已驳回' then
    normalized_reason := nullif(btrim(coalesce(target_rejection_reason, '')), '');
    if normalized_reason is null then
      raise exception '驳回时必须填写原因';
    end if;
  else
    normalized_reason := null;
  end if;

  update public.applications
  set
    status = normalized_status,
    approval_time = normalized_time,
    approver_name = requester_name,
    rejection_reason = normalized_reason
  where id = target_application_id
    and status = '待审批'
  returning * into updated_app;

  if updated_app.id is null then
    raise exception '未找到可更新的待审批记录';
  end if;

  insert into public.operation_logs (
    application_id,
    actor_user_id,
    actor_name,
    actor_role,
    action,
    details
  )
  values (
    updated_app.id,
    auth.uid(),
    requester_name,
    requester_role,
    case when normalized_status = '已通过' then 'approve_application' else 'reject_application' end,
    jsonb_build_object(
      'mode', 'single',
      'status', updated_app.status,
      'teacher_name', updated_app.teacher_name,
      'file_name', updated_app.file_name,
      'approval_time', updated_app.approval_time,
      'rejection_reason', updated_app.rejection_reason
    )
  );

  return updated_app.id;
end;
$$;

create or replace function public.admin_bulk_change_application_status(
  target_application_ids bigint[],
  target_status text,
  target_approval_time timestamptz default null,
  target_rejection_reason text default null
)
returns bigint[]
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_role text;
  requester_name text;
  normalized_status text;
  normalized_reason text;
  normalized_time timestamptz;
  normalized_ids bigint[];
  updated_ids bigint[];
begin
  select
    coalesce(role, 'teacher'),
    coalesce(
      public.nullif_placeholder_name(full_name),
      public.nullif_placeholder_name(username),
      '未命名用户'
    )
  into requester_role, requester_name
  from public.profiles
  where id = auth.uid();

  requester_role := coalesce(requester_role, 'teacher');
  requester_name := coalesce(public.nullif_placeholder_name(requester_name), '未命名用户');
  normalized_status := btrim(coalesce(target_status, ''));
  normalized_ids := array(
    select distinct unnest(coalesce(target_application_ids, '{}'::bigint[]))
  );

  if requester_role <> 'admin' then
    raise exception '只有管理员可以批量更新审批状态';
  end if;

  if coalesce(array_length(normalized_ids, 1), 0) = 0 then
    raise exception '请先选择至少一条记录';
  end if;

  if normalized_status not in ('已通过', '已驳回') then
    raise exception '仅支持批量通过或驳回待审批记录';
  end if;

  normalized_time := coalesce(target_approval_time, timezone('utc', now()));

  if normalized_status = '已驳回' then
    normalized_reason := nullif(btrim(coalesce(target_rejection_reason, '')), '');
    if normalized_reason is null then
      raise exception '批量驳回时必须填写原因';
    end if;
  else
    normalized_reason := null;
  end if;

  with updated as (
    update public.applications
    set
      status = normalized_status,
      approval_time = normalized_time,
      approver_name = requester_name,
      rejection_reason = normalized_reason
    where id = any(normalized_ids)
      and status = '待审批'
    returning *
  ), logged as (
    insert into public.operation_logs (
      application_id,
      actor_user_id,
      actor_name,
      actor_role,
      action,
      details
    )
    select
      updated.id,
      auth.uid(),
      requester_name,
      requester_role,
      case when normalized_status = '已通过' then 'approve_application' else 'reject_application' end,
      jsonb_build_object(
        'mode', 'batch',
        'status', updated.status,
        'teacher_name', updated.teacher_name,
        'file_name', updated.file_name,
        'approval_time', updated.approval_time,
        'rejection_reason', updated.rejection_reason
      )
    from updated
    returning 1
  )
  select coalesce(array_agg(updated.id order by updated.id), '{}'::bigint[])
  into updated_ids
  from updated;

  if coalesce(array_length(updated_ids, 1), 0) = 0 then
    raise exception '未找到可更新的待审批记录';
  end if;

  return updated_ids;
end;
$$;

create or replace function public.admin_delete_rejected_application(target_application_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_role text;
  requester_name text;
  deleted_app public.applications%rowtype;
  delete_scope text;
begin
  select
    coalesce(role, 'teacher'),
    coalesce(
      public.nullif_placeholder_name(full_name),
      public.nullif_placeholder_name(username),
      '未命名用户'
    )
  into requester_role, requester_name
  from public.profiles
  where id = auth.uid();

  requester_role := coalesce(requester_role, 'teacher');
  requester_name := coalesce(public.nullif_placeholder_name(requester_name), '未命名用户');

  delete from public.applications
  where id = target_application_id
    and status = '已驳回'
    and (
      requester_role = 'admin'
      or user_id = auth.uid()
    )
  returning * into deleted_app;

  if deleted_app.id is null then
    raise exception '未找到可删除的已驳回记录';
  end if;

  delete_scope := case when requester_role = 'admin' then 'admin' else 'owner' end;

  insert into public.operation_logs (
    application_id,
    actor_user_id,
    actor_name,
    actor_role,
    action,
    details
  )
  values (
    deleted_app.id,
    auth.uid(),
    requester_name,
    requester_role,
    'delete_rejected_application',
    jsonb_build_object(
      'mode', 'single',
      'scope', delete_scope,
      'status', deleted_app.status,
      'teacher_name', deleted_app.teacher_name,
      'file_name', deleted_app.file_name,
      'rejection_reason', deleted_app.rejection_reason
    )
  );

  return deleted_app.id;
end;
$$;

create or replace function public.admin_bulk_delete_rejected_applications(target_application_ids bigint[])
returns bigint[]
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_role text;
  requester_name text;
  normalized_ids bigint[];
  deleted_ids bigint[];
begin
  select
    coalesce(role, 'teacher'),
    coalesce(
      public.nullif_placeholder_name(full_name),
      public.nullif_placeholder_name(username),
      '未命名用户'
    )
  into requester_role, requester_name
  from public.profiles
  where id = auth.uid();

  requester_role := coalesce(requester_role, 'teacher');
  requester_name := coalesce(public.nullif_placeholder_name(requester_name), '未命名用户');
  normalized_ids := array(
    select distinct unnest(coalesce(target_application_ids, '{}'::bigint[]))
  );

  if requester_role <> 'admin' then
    raise exception '只有管理员可以批量删除已驳回记录';
  end if;

  if coalesce(array_length(normalized_ids, 1), 0) = 0 then
    raise exception '请先选择至少一条记录';
  end if;

  with deleted as (
    delete from public.applications
    where id = any(normalized_ids)
      and status = '已驳回'
    returning *
  ), logged as (
    insert into public.operation_logs (
      application_id,
      actor_user_id,
      actor_name,
      actor_role,
      action,
      details
    )
    select
      deleted.id,
      auth.uid(),
      requester_name,
      requester_role,
      'delete_rejected_application',
      jsonb_build_object(
        'mode', 'batch',
        'scope', 'admin',
        'status', deleted.status,
        'teacher_name', deleted.teacher_name,
        'file_name', deleted.file_name,
        'rejection_reason', deleted.rejection_reason
      )
    from deleted
    returning 1
  )
  select coalesce(array_agg(deleted.id order by deleted.id), '{}'::bigint[])
  into deleted_ids
  from deleted;

  if coalesce(array_length(deleted_ids, 1), 0) = 0 then
    raise exception '未找到可删除的已驳回记录';
  end if;

  return deleted_ids;
end;
$$;

update public.operation_logs as log_target
set actor_name = coalesce(
  public.nullif_placeholder_name(profile_target.full_name),
  public.nullif_placeholder_name(profile_target.username),
  log_target.actor_name
)
from public.profiles as profile_target
where profile_target.id = log_target.actor_user_id
  and public.nullif_placeholder_name(log_target.actor_name) is null
  and nullif(btrim(coalesce(log_target.actor_name, '')), '') is not null;

update public.applications as app_target
set approver_name = fixed_log.actor_name
from (
  select distinct on (log_target.application_id)
    log_target.application_id,
    log_target.actor_name
  from public.operation_logs as log_target
  where log_target.application_id is not null
    and public.nullif_placeholder_name(log_target.actor_name) is not null
  order by log_target.application_id, log_target.created_at desc, log_target.id desc
) as fixed_log
where fixed_log.application_id = app_target.id
  and public.nullif_placeholder_name(app_target.approver_name) is null
  and nullif(btrim(coalesce(app_target.approver_name, '')), '') is not null;

notify pgrst, 'reload schema';

commit;
