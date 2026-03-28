# Homework Approval System

Single-file web application for homework submission, review, export, and account management. The frontend runs as a static page and connects directly to Supabase.

## Online Access

After GitHub Pages is enabled for this repository, the system can be opened at:

- `https://loru12321.github.io/school-homework-approval/`

## Main Files

- `index.html`: main web entry for the system
- `school-homework-approval.html`: compatibility redirect to `index.html`
- `supabase/functions/bulk-create-users/index.ts`: Supabase Edge Function for bulk account creation
- `supabase/migrations/20260328232000_add_review_fields_and_user_indexes.sql`: migration for approval fields and indexes
- `supabase/migrations/20260328235900_secure_profile_role_sync.sql`: migration that keeps public signup as teacher-only and syncs admin status from secure metadata
- `scripts/bootstrap-admin.mjs`: script for securely creating the initial admin with the Service Role Key

## Recent Improvements

- Removed all Baidu Netdisk related entry points and dependencies
- Moved bulk account creation from the browser to a Supabase Edge Function so the frontend no longer requires a Service Role Key
- Added `approver_name` and `rejection_reason` to the approval flow
- Added indexes for `applications.user_id` and `applications.status`
- Closed the public admin self-signup hole in the web UI and changed role resolution to read from `profiles`
- Updated the bulk-create Edge Function to verify admin permission from `profiles.role` instead of trusting browser-supplied metadata
- Upgraded bulk PDF export into a browser-side download center with queued ZIP tasks, retry support, and repeat download support
- Kept the project as a static web app so it can be opened directly by URL after deployment

## Supabase Deployment

Run the migration:

```bash
supabase db push
```

Set the secret used by the Edge Function:

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

Deploy the Edge Function:

```bash
supabase functions deploy bulk-create-users
```

Securely create the first admin after the migration is deployed:

```bash
$env:SUPABASE_URL="https://your-project.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your_service_role_key"
$env:ADMIN_USERNAME="your_admin_username"
$env:ADMIN_PASSWORD="your_admin_password"
$env:ADMIN_NAME="系统管理员"
node scripts/bootstrap-admin.mjs
```

## Notes

- The Supabase CLI was not available in the current local environment during development, so the migration and Edge Function files were added to the repository but still need to be deployed in your Supabase project.
- GitHub Pages serves `index.html` from the repository root, so entering the site URL opens the system directly.
- PDF export archives are stored in the browser's local IndexedDB download center so finished ZIP files can be downloaded again without regenerating them immediately.
