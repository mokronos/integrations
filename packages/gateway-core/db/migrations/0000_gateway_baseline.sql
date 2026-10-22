CREATE TABLE `gateway_access_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_access_profile_name_tenant` ON `gateway_access_profile` (`tenant_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_access_profile_default_tenant` ON `gateway_access_profile` (`tenant_id`) WHERE is_default = 1;--> statement-breakpoint
CREATE TABLE `gateway_access_profile_tool` (
	`access_profile_id` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text,
	`integration` text NOT NULL,
	`connection_name` text NOT NULL,
	`tool` text NOT NULL,
	PRIMARY KEY(`access_profile_id`, `owner`, `subject`, `integration`, `connection_name`, `tool`),
	FOREIGN KEY (`access_profile_id`) REFERENCES `gateway_access_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_access_profile_tool_route` ON `gateway_access_profile_tool` (`access_profile_id`,`owner`,CASE WHEN subject IS NULL THEN '' ELSE subject END,`integration`,`connection_name`,`tool`);--> statement-breakpoint
CREATE TABLE `gateway_api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `gateway_client`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_api_key_hash_unique` ON `gateway_api_key` (`hash`);--> statement-breakpoint
CREATE TABLE `gateway_approval_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_approval_policy_name_tenant` ON `gateway_approval_policy` (`tenant_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_approval_policy_default_tenant` ON `gateway_approval_policy` (`tenant_id`) WHERE is_default = 1;--> statement-breakpoint
CREATE TABLE `gateway_approval_policy_tool` (
	`approval_policy_id` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text,
	`integration` text NOT NULL,
	`connection_name` text NOT NULL,
	`tool` text NOT NULL,
	`decision` text NOT NULL,
	PRIMARY KEY(`approval_policy_id`, `owner`, `subject`, `integration`, `connection_name`, `tool`),
	FOREIGN KEY (`approval_policy_id`) REFERENCES `gateway_approval_policy`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_approval_policy_tool_route` ON `gateway_approval_policy_tool` (`approval_policy_id`,`owner`,CASE WHEN subject IS NULL THEN '' ELSE subject END,`integration`,`connection_name`,`tool`);--> statement-breakpoint
CREATE TABLE `gateway_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text,
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
CREATE TABLE `gateway_client` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`access_profile_id` text NOT NULL,
	`approval_policy_id` text NOT NULL,
	`name` text NOT NULL,
	`capabilities` text NOT NULL,
	`approval_delivery` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`access_profile_id`) REFERENCES `gateway_access_profile`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_policy_id`) REFERENCES `gateway_approval_policy`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_client_name_tenant` ON `gateway_client` (`tenant_id`,`name`);--> statement-breakpoint
CREATE TABLE `gateway_external_identity` (
	`provider` text NOT NULL,
	`provider_subject` text NOT NULL,
	`subject_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `provider_subject`),
	FOREIGN KEY (`subject_id`) REFERENCES `gateway_subject`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gateway_identity_oauth_state` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`handoff_hash` text,
	`return_path` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gateway_login` (
	`subject_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `gateway_subject`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_login_email_unique` ON `gateway_login` (`email`);--> statement-breakpoint
CREATE TABLE `gateway_login_handoff` (
	`request_hash` text PRIMARY KEY NOT NULL,
	`subject_id` text,
	`tenant_id` text,
	`email` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`collected_at` integer,
	FOREIGN KEY (`subject_id`) REFERENCES `gateway_subject`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gateway_pending_approval` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`approval_policy_id` text NOT NULL,
	`access_profile_id` text NOT NULL,
	`alias` text NOT NULL,
	`tool` text NOT NULL,
	`arguments` text NOT NULL,
	`arguments_lookup` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`result` text,
	`error` text,
	`collected_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `gateway_client`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approval_policy_id`) REFERENCES `gateway_approval_policy`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`access_profile_id`) REFERENCES `gateway_access_profile`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gateway_pending_approval_retry` ON `gateway_pending_approval` (`approval_policy_id`,`access_profile_id`,`tool`,`arguments_lookup`,`arguments`) WHERE collected_at IS NULL;--> statement-breakpoint
CREATE TABLE `gateway_session` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `gateway_subject`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gateway_subject` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gateway_tenant` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_tenant_name_unique` ON `gateway_tenant` (`name`);--> statement-breakpoint
CREATE TABLE `gateway_tool_snapshot` (
	`tenant_id` text NOT NULL,
	`integration` text NOT NULL,
	`connection_name` text NOT NULL,
	`tool` text NOT NULL,
	`input_schema` text,
	`output_schema` text,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `integration`, `connection_name`, `tool`),
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
