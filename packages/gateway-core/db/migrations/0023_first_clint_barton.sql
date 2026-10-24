CREATE TABLE `gateway_app_session` (
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
	`result` text NOT NULL,
	`resource_uri` text NOT NULL,
	`context` text,
	`messages` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `gateway_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gateway_app_session_expiry` ON `gateway_app_session` (`expires_at`);