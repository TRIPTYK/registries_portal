import { Migration } from "@mikro-orm/migrations";

export class Migration20261026083909_initial extends Migration {
  override up(): void | Promise<void> {
    this.addSql(
      `create table "access_record" ("id" varchar(255) not null, "seq" int not null, "accessed_at" varchar(255) not null, "encoded_at" varchar(255) not null, "encoded_by" varchar(255) not null, "accessor_ref" varchar(255) not null, "data_subject_ref" varchar(255) not null, "data_categories" text[] not null, "is_special_category" boolean not null default false, "access_type" varchar(255) not null, "purpose" varchar(255) not null, "legal_basis" varchar(255) not null, "source_system" varchar(255) not null, "recipient" varchar(255) null, "justification" varchar(255) not null, "retention_until" varchar(255) not null, "prev_hash" varchar(255) not null, "hash" varchar(255) not null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "access_record" add constraint "access_record_seq_unique" unique ("seq");`,
    );
    this.addSql(
      `alter table "access_record" add constraint "access_record_hash_unique" unique ("hash");`,
    );

    this.addSql(
      `create table "audit_event" ("id" varchar(255) not null, "seq" int not null, "occurred_at" varchar(255) not null, "actor_id" varchar(255) not null, "action" varchar(255) not null, "target_type" varchar(255) not null, "target_ref" varchar(255) not null, "outcome" varchar(255) not null, "ip" varchar(255) not null, "user_agent" varchar(255) null, "prev_hash" varchar(255) not null, "hash" varchar(255) not null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "audit_event" add constraint "audit_event_seq_unique" unique ("seq");`,
    );
    this.addSql(
      `alter table "audit_event" add constraint "audit_event_hash_unique" unique ("hash");`,
    );

    this.addSql(
      `create table "data_category" ("id" varchar(255) not null, "code" varchar(255) not null, "label" varchar(255) not null, "label_en" varchar(255) null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "data_category" add constraint "data_category_code_unique" unique ("code");`,
    );

    this.addSql(
      `create table "incident" ("id" varchar(255) not null, "seq" int not null, "reference" varchar(255) not null, "canonical_version" int not null default 1, "revision" int not null default 1, "superseded_by_id" varchar(255) null, "updated_by" varchar(255) null, "updated_at" varchar(255) null, "deleted_at" varchar(255) null, "deleted_by" varchar(255) null, "report_date" varchar(255) not null, "version" varchar(255) not null, "classification" varchar(255) not null, "status" varchar(255) not null, "application_name" varchar(255) not null, "application_detail" varchar(255) not null, "environment" varchar(255) not null, "client_code" varchar(255) not null, "client_name" varchar(255) not null, "reported_by" varchar(255) not null, "encoded_by" varchar(255) not null, "encoded_at" varchar(255) not null, "recipient_name" varchar(255) not null, "recipient_org" varchar(255) not null, "legal_context" text not null, "service_name" varchar(255) not null, "deployed_version" varchar(255) not null, "incident_start_at" varchar(255) not null, "incident_end_at" varchar(255) null, "detected_at" varchar(255) not null, "resolved_at" varchar(255) null, "resolution_duration_minutes" int null, "technical_lead_id" varchar(255) null, "description" text not null, "description_sections" jsonb null, "personal_data_impacted" boolean not null default false, "special_category_data" boolean not null default false, "apd_notification_required" boolean null, "impact_summary" varchar(255) not null, "impact_details" jsonb null, "severity_operational" varchar(255) null, "severity_compliance" varchar(255) null, "severity_overall" varchar(255) null, "affected_persons_count" int null, "affected_patients_count" int null, "immediate_cause" varchar(255) not null, "contributing_factors" jsonb not null, "corrective_actions" jsonb not null, "preventive_measures" jsonb not null, "communication_plan" jsonb null, "conclusion" text not null, "timeline_events" jsonb not null, "access_logs" jsonb null, "issuer_signature" jsonb not null, "recipient_signature" jsonb not null, "prev_hash" varchar(255) not null, "hash" varchar(255) not null, primary key ("id"));`,
    );
    this.addSql(`alter table "incident" add constraint "incident_seq_unique" unique ("seq");`);
    this.addSql(`alter table "incident" add constraint "incident_hash_unique" unique ("hash");`);

    this.addSql(
      `create table "legal_basis" ("id" varchar(255) not null, "code" varchar(255) not null, "label" varchar(255) not null, "label_en" varchar(255) null, "is_article9" boolean not null default false, primary key ("id"));`,
    );
    this.addSql(
      `alter table "legal_basis" add constraint "legal_basis_code_unique" unique ("code");`,
    );

    this.addSql(
      `create table "purpose" ("id" varchar(255) not null, "code" varchar(255) not null, "label" varchar(255) not null, "label_en" varchar(255) null, primary key ("id"));`,
    );
    this.addSql(`alter table "purpose" add constraint "purpose_code_unique" unique ("code");`);

    this.addSql(
      `create table "refresh_tokens" ("id" varchar(255) not null, "token_hash" varchar(255) not null, "user_id" varchar(255) not null, "device_info" varchar(255) null, "ip_address" varchar(255) null, "user_agent" varchar(255) null, "issued_at" date not null, "expires_at" date not null, "revoked_at" date null, "family_id" varchar(255) not null, primary key ("id"));`,
    );
    this.addSql(
      `create index "refresh_tokens_token_hash_index" on "refresh_tokens" ("token_hash");`,
    );
    this.addSql(`create index "refresh_tokens_user_id_index" on "refresh_tokens" ("user_id");`);
    this.addSql(
      `create index "refresh_tokens_expires_at_index" on "refresh_tokens" ("expires_at");`,
    );
    this.addSql(`create index "refresh_tokens_family_id_index" on "refresh_tokens" ("family_id");`);

    this.addSql(
      `create table "retention_policy" ("id" varchar(255) not null, "category" varchar(255) not null, "duration_days" int not null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "retention_policy" add constraint "retention_policy_category_unique" unique ("category");`,
    );

    this.addSql(
      `create table "role" ("id" varchar(255) not null, "name" varchar(255) not null, "description" varchar(255) null, primary key ("id"));`,
    );
    this.addSql(`alter table "role" add constraint "role_name_unique" unique ("name");`);

    this.addSql(
      `create table "permission_rule" ("id" varchar(255) not null, "role_id" varchar(255) not null, "action" varchar(255) not null, "subject" varchar(255) not null, "conditions" jsonb null, "fields" jsonb null, "inverted" boolean not null default false, "order" int not null default 0, primary key ("id"));`,
    );

    this.addSql(
      `create table "source_system" ("id" varchar(255) not null, "code" varchar(255) not null, "label" varchar(255) not null, "label_en" varchar(255) null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "source_system" add constraint "source_system_code_unique" unique ("code");`,
    );

    this.addSql(
      `create table "todo" ("id" varchar(255) not null, "title" varchar(255) not null, "description" varchar(255) null, "completed" boolean not null default false, "user_id" varchar(255) not null, "created_at" varchar(255) not null, "updated_at" varchar(255) not null, primary key ("id"));`,
    );

    this.addSql(
      `create table "user" ("id" varchar(255) not null, "email" varchar(255) not null, "first_name" varchar(255) not null, "last_name" varchar(255) not null, "password" varchar(255) not null, "role_id" varchar(255) not null, "failed_login_attempts" int not null default 0, "locked_until" varchar(255) null, "password_changed_at" varchar(255) null, primary key ("id"));`,
    );

    this.addSql(
      `alter table "permission_rule" add constraint "permission_rule_role_id_foreign" foreign key ("role_id") references "role" ("id");`,
    );

    this.addSql(
      `alter table "user" add constraint "user_role_id_foreign" foreign key ("role_id") references "role" ("id");`,
    );
  }
}
