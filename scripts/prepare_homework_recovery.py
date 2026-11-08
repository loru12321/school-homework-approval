"""Prepare private SQL batches from the local Supabase JSON backup.

Usage: python scripts/prepare_homework_recovery.py BACKUP_JSON OUTPUT_DIR
The output directory contains sensitive data and must never be committed.
"""

import csv
import json
import secrets
import sys
from pathlib import Path

import bcrypt


def quote(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def rows(backup, kind, name):
    matches = [entry for entry in backup if entry["kind"] == kind and entry["name"] == name]
    if len(matches) != 1:
        raise ValueError(f"Expected one {kind}/{name}; found {len(matches)}")
    return json.loads(matches[0]["payload"])


def write_batch(path, table, batch):
    columns = list(batch[0])
    payload = json.dumps(batch, ensure_ascii=False, separators=(",", ":"))
    column_sql = ", ".join('"' + col + '"' for col in columns)
    if table == "app_settings":
        conflict = "on conflict (setting_key) do update set setting_value = excluded.setting_value"
    elif table == "profiles":
        conflict = "on conflict (id) do update set username = excluded.username, full_name = excluded.full_name, role = excluded.role"
    else:
        conflict = "on conflict do nothing"
    sql = (
        f"insert into public.{table} ({column_sql})\n"
        f"select {column_sql} from jsonb_populate_recordset(null::public.{table}, {quote(payload)}::jsonb)\n"
        f"{conflict};\n"
    )
    path.write_text(sql, encoding="utf-8")


def main():
    backup_path, output_dir = map(Path, sys.argv[1:3])
    output_dir.mkdir(parents=True, exist_ok=True)
    backup = json.loads(backup_path.read_text(encoding="utf-8-sig"))
    users = rows(backup, "auth_users", "auth.users")
    profiles = rows(backup, "data", "public.profiles")
    if len(users) != len(profiles) or {u["id"] for u in users} != {p["id"] for p in profiles}:
        raise ValueError("Auth users and profiles do not match")

    password_file = output_dir / "temporary-passwords.csv"
    existing_passwords = {}
    if password_file.exists():
        with password_file.open(newline="", encoding="utf-8-sig") as stream:
            existing_passwords = {row["username"]: row["temporary_password"] for row in csv.DictReader(stream)}
        if set(existing_passwords) != {p["username"] for p in profiles}:
            raise ValueError("Existing password file does not match backup profiles")

    auth_sql = []
    credentials = []
    for user in users:
        profile = next(p for p in profiles if p["id"] == user["id"])
        password = existing_passwords.get(profile["username"]) or secrets.token_urlsafe(18)
        password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()
        user_id = user["id"]
        email = user["email"]
        created_at = user.get("created_at")
        user_meta = json.dumps(user.get("raw_user_meta_data") or {}, ensure_ascii=False)
        app_meta = json.dumps(user.get("raw_app_meta_data") or {}, ensure_ascii=False)
        auth_sql.append(
            "insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,"
            "raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,"
            "email_change_token_new,email_change,last_sign_in_at) values ("
            f"'00000000-0000-0000-0000-000000000000'::uuid,{quote(user_id)}::uuid,'authenticated','authenticated',"
            f"{quote(email)},{quote(password_hash)},now(),{quote(app_meta)}::jsonb,{quote(user_meta)}::jsonb,"
            f"{quote(created_at)}::timestamptz,now(),'','','','',{quote(created_at)}::timestamptz) "
            "on conflict (id) do nothing;"
        )
        identity_data = json.dumps({"sub": user_id, "email": email, "email_verified": True, "phone_verified": False})
        auth_sql.append(
            "insert into auth.identities (provider_id,user_id,identity_data,provider,created_at,updated_at) "
            f"values ({quote(user_id)},{quote(user_id)}::uuid,{quote(identity_data)}::jsonb,'email',"
            "now(),now()) on conflict do nothing;"
        )
        credentials.append({"username": profile["username"], "name": profile["full_name"],
                            "role": profile["role"], "temporary_password": password})

    (output_dir / "auth.sql").write_text("\n".join(auth_sql) + "\n", encoding="utf-8")
    with (output_dir / "temporary-passwords.csv").open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=["username", "name", "role", "temporary_password"])
        writer.writeheader()
        writer.writerows(credentials)

    for table, batch_size in (("profiles", 20), ("applications", 25),
                              ("operation_logs", 25), ("app_settings", 20)):
        data = rows(backup, "data", "public." + table)
        for i in range(0, len(data), batch_size):
            write_batch(output_dir / f"{table}-{i // batch_size + 1:02d}.sql", table, data[i:i + batch_size])
    (output_dir / "sequences.sql").write_text(
        "select setval('public.applications_id_seq', coalesce((select max(id) from public.applications), 1), true);\n"
        "select setval('public.operation_logs_id_seq', coalesce((select max(id) from public.operation_logs), 1), true);\n",
        encoding="utf-8",
    )
    print(f"Prepared {len(users)} auth users, {len(rows(backup, 'data', 'public.applications'))} applications, "
          f"{len(rows(backup, 'data', 'public.operation_logs'))} operation logs")


if __name__ == "__main__":
    main()
