CREATE TABLE `gateway_invocation_key` (
	`tenant_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`alias` text NOT NULL,
	`tool` text NOT NULL,
	`status` text NOT NULL,
	`approval_id` text,
	`outcome` text,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	PRIMARY KEY(`tenant_id`, `profile_id`, `idempotency_key`),
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `gateway_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gateway_invocation_key_sweep` ON `gateway_invocation_key` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `gateway_pending_approval` ADD `idempotency_key` text;