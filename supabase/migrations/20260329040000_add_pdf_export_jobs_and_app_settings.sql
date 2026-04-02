begin;

create or replace function public.set_row_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.app_settings (
  setting_key text primary key,
  setting_value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by uuid
);

comment on table public.app_settings is '系统级配置表，用于保存 PDF 模板等后台配置';
comment on column public.app_settings.setting_key is '配置键，例如 pdf_template';
comment on column public.app_settings.setting_value is '配置 JSON 内容';

drop trigger if exists set_app_settings_updated_at on public.app_settings;
create trigger set_app_settings_updated_at
before update on public.app_settings
for each row
execute function public.set_row_updated_at();

alter table public.app_settings enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'app_settings'
      and policyname = 'app_settings_authenticated_select'
  ) then
    create policy app_settings_authenticated_select
      on public.app_settings
      for select
      to authenticated
      using (true);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'app_settings'
      and policyname = 'app_settings_admin_insert'
  ) then
    create policy app_settings_admin_insert
      on public.app_settings
      for insert
      to authenticated
      with check (
        exists (
          select 1
          from public.profiles requester
          where requester.id = auth.uid()
            and requester.role = 'admin'
        )
      );
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'app_settings'
      and policyname = 'app_settings_admin_update'
  ) then
    create policy app_settings_admin_update
      on public.app_settings
      for update
      to authenticated
      using (
        exists (
          select 1
          from public.profiles requester
          where requester.id = auth.uid()
            and requester.role = 'admin'
        )
      )
      with check (
        exists (
          select 1
          from public.profiles requester
          where requester.id = auth.uid()
            and requester.role = 'admin'
        )
      );
  end if;
end;
$$;

revoke all on table public.app_settings from public;
grant select, insert, update on table public.app_settings to authenticated;

insert into public.app_settings (setting_key, setting_value)
values (
  'pdf_template',
  '{
    "schoolName": "学校教务处",
    "headerTitle": "作业公示单",
    "headerSubtitle": "HOMEWORK APPROVAL NOTICE",
    "signOffText": "学校教务处",
    "sealLabel": "教务专用章",
    "sealOffsetX": 0,
    "sealOffsetY": 0,
    "pdfFileNamePattern": "{file_name}",
    "archiveFileNamePattern": "{mode}_{count}份_{timestamp}"
  }'::jsonb
)
on conflict (setting_key) do nothing;

create table if not exists public.pdf_export_jobs (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null,
  created_by_name text not null,
  status text not null default 'queued',
  mode_label text not null,
  filter_snapshot jsonb not null default '{}'::jsonb,
  filter_summary text not null default '',
  folder_mode text not null default 'flat',
  items jsonb not null default '[]'::jsonb,
  total_count integer not null default 0,
  completed_count integer not null default 0,
  archive_name text not null default '',
  archive_path text,
  progress_text text not null default '',
  error_message text not null default '',
  use_filters boolean not null default true,
  cancel_requested boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  constraint pdf_export_jobs_status_chk check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  constraint pdf_export_jobs_folder_mode_chk check (folder_mode in ('flat', 'grade', 'grade_subject', 'teacher')),
  constraint pdf_export_jobs_total_count_chk check (total_count >= 0),
  constraint pdf_export_jobs_completed_count_chk check (completed_count >= 0 and completed_count <= total_count)
);

comment on table public.pdf_export_jobs is '后台 PDF 导出任务表，记录导出进度、结果 ZIP 和错误信息';
comment on column public.pdf_export_jobs.items is '待导出记录快照，避免任务执行时前端列表变化影响结果';
comment on column public.pdf_export_jobs.archive_path is 'Storage 内 ZIP 存储路径';

create index if not exists pdf_export_jobs_created_by_idx
  on public.pdf_export_jobs (created_by);

create index if not exists pdf_export_jobs_status_idx
  on public.pdf_export_jobs (status);

create index if not exists pdf_export_jobs_created_at_idx
  on public.pdf_export_jobs (created_at desc);

drop trigger if exists set_pdf_export_jobs_updated_at on public.pdf_export_jobs;
create trigger set_pdf_export_jobs_updated_at
before update on public.pdf_export_jobs
for each row
execute function public.set_row_updated_at();

alter table public.pdf_export_jobs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'pdf_export_jobs'
      and policyname = 'pdf_export_jobs_admin_select'
  ) then
    create policy pdf_export_jobs_admin_select
      on public.pdf_export_jobs
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.profiles requester
          where requester.id = auth.uid()
            and requester.role = 'admin'
        )
      );
  end if;
end;
$$;

revoke all on table public.pdf_export_jobs from public;
grant select on table public.pdf_export_jobs to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
select
  'pdf-export-archives',
  'pdf-export-archives',
  false,
  104857600,
  array['application/zip']
where not exists (
  select 1
  from storage.buckets
  where id = 'pdf-export-archives'
);

commit;
