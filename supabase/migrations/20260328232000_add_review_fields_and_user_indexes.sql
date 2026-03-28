begin;

alter table if exists public.applications
  add column if not exists approver_name text;

alter table if exists public.applications
  add column if not exists rejection_reason text;

comment on column public.applications.approver_name is '处理该申报的管理员姓名';
comment on column public.applications.rejection_reason is '驳回原因，仅在状态为已驳回时填写';

update public.applications
set rejection_reason = null
where status is distinct from '已驳回';

create index if not exists applications_user_id_idx
  on public.applications (user_id);

create index if not exists applications_status_idx
  on public.applications (status);

commit;
