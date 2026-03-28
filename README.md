# 教务作业审批

单文件版作业审批系统，基于 Vue 3、Tailwind CSS、SheetJS、jsPDF 和 Supabase。

## 本次已完成优化

- 移除百度网盘相关入口、配置项和依赖说明，审批流改为站内审批加站内导出。
- 增加教师端和管理员端统计卡片、状态筛选和管理员搜索，提升日常操作效率。
- 修复 `datetime-local` 使用 UTC 导致时间偏移的问题，统一改为本地时间处理。
- 修复导入历史作业时忽略布置时间、文件编号不稳定、空内容未过滤等衍生问题。
- 加强登录、注册、提交、审批、导入、导出、复制编号和 PDF 生成的异常处理。
- 去掉对 `system_settings.pan_link` 和 `is_deleted = false` 的硬耦合，降低数据库字段差异带来的报错风险。
- 将批量创建账号迁移到 Supabase Edge Function，前端不再要求输入 Service Role Key。
- 为审批补充 `approver_name` 和 `rejection_reason` 字段，并在前端展示、导出中同步体现。
- 为 `applications.user_id` 和 `applications.status` 增加数据库索引，改善查询性能。

## 文件

- `school-homework-approval.html`：系统主文件
- `supabase/functions/bulk-create-users/index.ts`：批量创建账号的 Edge Function
- `supabase/migrations/20260328232000_add_review_fields_and_user_indexes.sql`：新增审批字段与索引的数据库迁移

## Supabase 部署

1. 应用数据库迁移

```bash
supabase db push
```

2. 为 Edge Function 配置服务端密钥

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=你的_service_role_key
```

3. 部署批量创建账号函数

```bash
supabase functions deploy bulk-create-users
```

4. 部署后，管理员端“导入账号”会自动调用该函数

## 建议继续落地的改进

- 为 `profiles` 表补齐自动同步触发器，确保注册后账号管理页展示一致。
- 为 `applications.status` 引入枚举或约束，避免手工写入脏状态值。
- 为管理员审批和批量建号增加操作日志，便于审计与追责。
