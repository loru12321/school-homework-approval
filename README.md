# Homework Approval System

Single-file web application for homework submission, review, export, and account management. The frontend runs as a static page and connects directly to Supabase.

## Online Access

After GitHub Pages is enabled for this repository, the system can be opened at:

- `https://loru12321.github.io/school-homework-approval/`

## Main Files

- `index.html`: main web entry for the system
- `school-homework-approval.html`: compatibility redirect to `index.html`
- `supabase/functions/bulk-create-users/index.ts`: Supabase Edge Function for bulk account creation
- `supabase/functions/delete-rejected-applications/index.ts`: Supabase Edge Function for deleting rejected records and cleaning related export artifacts
- `supabase/functions/pdf-export-jobs/index.ts`: Supabase Edge Function for background PDF export jobs
- `supabase/migrations/20260328232000_add_review_fields_and_user_indexes.sql`: migration for approval fields and indexes
- `supabase/migrations/20260328235900_secure_profile_role_sync.sql`: migration that keeps public signup as teacher-only and syncs admin status from secure metadata
- `supabase/migrations/20260329040000_add_pdf_export_jobs_and_app_settings.sql`: migration for PDF export jobs, private ZIP storage bucket, and PDF template settings
- `supabase/migrations/20260404020000_cleanup_pdf_export_jobs_on_application_delete.sql`: migration for locating export jobs and ZIP archives that reference deleted applications
- `scripts/bootstrap-admin.mjs`: script for securely creating the initial admin with the Service Role Key

## Recent Improvements

- Removed all Baidu Netdisk related entry points and dependencies
- Moved bulk account creation from the browser to a Supabase Edge Function so the frontend no longer requires a Service Role Key
- Added `approver_name` and `rejection_reason` to the approval flow
- Added indexes for `applications.user_id` and `applications.status`
- Closed the public admin self-signup hole in the web UI and changed role resolution to read from `profiles`
- Updated the bulk-create Edge Function to verify admin permission from `profiles.role` instead of trusting browser-supplied metadata
- Added admin-side approval filters for grade, subject, teacher, and time range
- Expanded the dashboard with today submissions, weekly reviews, grade distribution, subject distribution, and rejection rate
- Made the PDF template configurable for school name, header, sign-off, stamp position, and naming rules
- Migrated bulk PDF export into a Supabase Edge Function background job system with backend ZIP generation, retry support, and repeat download support
- Deleting rejected records now also clears related PDF export jobs and ZIP archives so storage does not accumulate orphaned files
- Kept the project as a static web app so it can be opened directly by URL after deployment

## Supabase Deployment

Run the migration:

```bash
supabase db push
```

Set the secret used by the Edge Function:

```bash
supabase secrets set PROJECT_SERVICE_ROLE_KEY=your_service_role_key
```

Deploy the Edge Function:

```bash
supabase functions deploy bulk-create-users
supabase functions deploy delete-rejected-applications
supabase functions deploy pdf-export-jobs
```

Securely create the first admin after the migration is deployed:

```bash
$env:SUPABASE_URL="https://your-project.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your_service_role_key"
$env:ADMIN_USERNAME="your_admin_username"
$env:ADMIN_PASSWORD="your_admin_password"
$env:ADMIN_NAME="System Administrator"
node scripts/bootstrap-admin.mjs
```

## Notes

- The Supabase CLI was not available in the current local environment during development, so the migration and Edge Function files were added to the repository but still need to be deployed in your Supabase project.
- The `pdf-export-jobs` function fetches an open-source CJK font at runtime so backend-generated PDFs can render Chinese text correctly.
- GitHub Pages serves `index.html` from the repository root, so entering the site URL opens the system directly.
- PDF export archives are stored in the private Supabase Storage bucket `pdf-export-archives`, and the web app downloads them through signed URLs.
