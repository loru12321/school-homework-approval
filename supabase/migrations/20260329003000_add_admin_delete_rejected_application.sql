begin;

create or replace function public.admin_delete_rejected_application(target_application_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_role text;
  deleted_id bigint;
begin
  select role
  into requester_role
  from public.profiles
  where id = auth.uid();

  if requester_role <> 'admin' then
    raise exception '只有管理员可以删除已驳回记录';
  end if;

  delete from public.applications
  where id = target_application_id
    and status = '已驳回'
  returning id into deleted_id;

  if deleted_id is null then
    raise exception '未找到可删除的已驳回记录';
  end if;

  return deleted_id;
end;
$$;

comment on function public.admin_delete_rejected_application(bigint) is
  '仅允许管理员物理删除已驳回的 applications 记录';

revoke all on function public.admin_delete_rejected_application(bigint) from public;
grant execute on function public.admin_delete_rejected_application(bigint) to authenticated;

delete from public.applications
where file_name like '__deleted__:%';

notify pgrst, 'reload schema';

commit;
