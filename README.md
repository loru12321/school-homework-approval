# 教务作业审批

单文件版作业审批系统，基于 Vue 3、Tailwind CSS、SheetJS、jsPDF 和 Supabase。

## 本次已完成优化

- 移除百度网盘相关入口、配置项和依赖说明，审批流改为站内审批加站内导出。
- 增加教师端和管理员端统计卡片、状态筛选和管理员搜索，提升日常操作效率。
- 修复 `datetime-local` 使用 UTC 导致时间偏移的问题，统一改为本地时间处理。
- 修复导入历史作业时忽略布置时间、文件编号不稳定、空内容未过滤等衍生问题。
- 加强登录、注册、提交、审批、导入、导出、复制编号和 PDF 生成的异常处理。
- 去掉对 `system_settings.pan_link` 和 `is_deleted = false` 的硬耦合，降低数据库字段差异带来的报错风险。

## 文件

- `教务作业审批系统(1).html`：系统主文件

## 建议继续落地的改进

- 将批量创建账号从前端迁移到 Supabase Edge Function，避免管理员在浏览器中输入 Service Role Key。
- 为审批增加“驳回原因”和“审批人”字段，提升追溯性。
- 在 Supabase 侧补充 `applications.user_id`、`applications.status` 等索引，优化数据量变大后的查询性能。
- 为 `profiles` 表补齐自动同步触发器，确保注册后账号管理页展示一致。
