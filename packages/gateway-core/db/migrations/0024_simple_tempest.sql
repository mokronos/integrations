CREATE TABLE `gateway_oauth_device_request` (
	`device_code_hash` text PRIMARY KEY NOT NULL,
	`user_code` text NOT NULL,
	`application_id` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`grant_id` text,
	`denied_at` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `gateway_oauth_application`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `gateway_oauth_grant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_oauth_device_request_user_code_unique` ON `gateway_oauth_device_request` (`user_code`);