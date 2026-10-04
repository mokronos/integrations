CREATE TABLE `gateway_api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `gateway_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_api_key_hash_unique` ON `gateway_api_key` (`hash`);--> statement-breakpoint
CREATE TABLE `gateway_approval_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`approval_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`next_attempt_at` integer,
	`delivered_at` integer,
	`last_error` text,
	FOREIGN KEY (`approval_id`) REFERENCES `gateway_pending_approval`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `gateway_approval_destination`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_approval_delivery_once` ON `gateway_approval_delivery` (`approval_id`,`destination_id`);--> statement-breakpoint
CREATE INDEX `gateway_approval_delivery_due` ON `gateway_approval_delivery` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `gateway_approval_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text,
	`integration` text NOT NULL,
	`connection_name` text NOT NULL,
	`tool` text NOT NULL,
	`pattern` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`profile_id`) REFERENCES `gateway_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gateway_approval_rule_route` ON `gateway_approval_rule` (`profile_id`,`integration`,`connection_name`,`tool`);--> statement-breakpoint
CREATE TABLE `gateway_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`profile_id` text,
	`api_key_id` text,
	`oauth_grant_id` text,
	`oauth_application_id` text,
	`credential_name` text,
	`agent` text,
	`authorized_by_subject_id` text,
	`alias` text,
	`tool` text,
	`owner` text,
	`subject` text,
	`integration` text,
	`connection_name` text,
	`decision` text,
	`outcome` text NOT NULL,
	`message` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gateway_audit_arguments` (
	`audit_id` text PRIMARY KEY NOT NULL,
	`arguments` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`audit_id`) REFERENCES `gateway_audit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gateway_oauth_authorization_code` (
	`hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`application_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`grant_id`) REFERENCES `gateway_oauth_grant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`application_id`) REFERENCES `gateway_oauth_application`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gateway_oauth_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`application_id`) REFERENCES `gateway_oauth_application`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_id`) REFERENCES `gateway_subject`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `gateway_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_oauth_grant_binding` ON `gateway_oauth_grant` (`application_id`,`subject_id`,`profile_id`,`resource`,`scope`);--> statement-breakpoint
CREATE TABLE `gateway_oauth_token` (
	`hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`family_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`application_id` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`replaced_by_hash` text,
	FOREIGN KEY (`grant_id`) REFERENCES `gateway_oauth_grant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`application_id`) REFERENCES `gateway_oauth_application`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gateway_oauth_token_family` ON `gateway_oauth_token` (`family_id`);--> statement-breakpoint
CREATE INDEX `gateway_oauth_token_grant` ON `gateway_oauth_token` (`grant_id`);--> statement-breakpoint
CREATE TABLE `gateway_pending_approval` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`api_key_id` text,
	`oauth_grant_id` text,
	`oauth_application_id` text,
	`credential_name` text,
	`agent` text,
	`alias` text NOT NULL,
	`tool` text NOT NULL,
	`arguments` text NOT NULL,
	`arguments_lookup` text,
	`group_id` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`result` text,
	`error` text,
	`collected_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `gateway_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gateway_pending_approval_retry` ON `gateway_pending_approval` (`tenant_id`,`profile_id`,`alias`,`tool`,`arguments_lookup`,`arguments`) WHERE collected_at IS NULL;--> statement-breakpoint
CREATE INDEX `gateway_pending_approval_group` ON `gateway_pending_approval` (`group_id`,`status`);--> statement-breakpoint
CREATE INDEX `gateway_pending_approval_open` ON `gateway_pending_approval` (`profile_id`,`tool`,`status`);--> statement-breakpoint
CREATE TABLE `gateway_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`capabilities` text NOT NULL,
	`approval_method` text DEFAULT 'elicitation' NOT NULL,
	`mcp_surface` text DEFAULT 'tools' NOT NULL,
	`approval_group_window_minutes` integer DEFAULT 30 NOT NULL,
	`include_new_tools` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_profile_name_tenant` ON `gateway_profile` (`tenant_id`,`name`);--> statement-breakpoint
CREATE TABLE `gateway_profile_approval_destination` (
	`profile_id` text NOT NULL,
	`destination_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `destination_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `gateway_profile`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `gateway_approval_destination`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gateway_profile_tool` (
	`profile_id` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text,
	`integration` text NOT NULL,
	`connection_name` text NOT NULL,
	`tool` text NOT NULL,
	`decision` text NOT NULL,
	PRIMARY KEY(`profile_id`, `owner`, `subject`, `integration`, `connection_name`, `tool`),
	FOREIGN KEY (`profile_id`) REFERENCES `gateway_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_profile_tool_route` ON `gateway_profile_tool` (`profile_id`,`owner`,CASE WHEN subject IS NULL THEN '' ELSE subject END,`integration`,`connection_name`,`tool`);