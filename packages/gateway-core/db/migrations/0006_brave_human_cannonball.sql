CREATE TABLE `gateway_oauth_application` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`client_identifier` text NOT NULL,
	`name` text NOT NULL,
	`redirect_uris_json` text NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_oauth_application_client_identifier_unique` ON `gateway_oauth_application` (`client_identifier`);--> statement-breakpoint
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
CREATE TABLE `gateway_oauth_authorization_request` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`state` text,
	`code_challenge` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`application_id`) REFERENCES `gateway_oauth_application`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gateway_oauth_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`application_id`) REFERENCES `gateway_oauth_application`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_id`) REFERENCES `gateway_subject`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `gateway_client`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_oauth_grant_binding` ON `gateway_oauth_grant` (`application_id`,`subject_id`,`client_id`,`resource`,`scope`);--> statement-breakpoint
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
ALTER TABLE `gateway_audit` ADD `oauth_grant_id` text;--> statement-breakpoint
ALTER TABLE `gateway_audit` ADD `oauth_application_id` text;--> statement-breakpoint
ALTER TABLE `gateway_audit` ADD `authorized_by_subject_id` text;