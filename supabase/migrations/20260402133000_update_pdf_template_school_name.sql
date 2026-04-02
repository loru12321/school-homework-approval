update public.app_settings
set
  setting_value = jsonb_set(
    jsonb_set(
      setting_value,
      '{schoolName}',
      to_jsonb('银山镇实验学校教务处'::text),
      true
    ),
    '{signOffText}',
    to_jsonb('银山镇实验学校教务处'::text),
    true
  ),
  updated_at = now()
where setting_key = 'pdf_template';
