CREATE TABLE `gateway_approval_decision_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`approval_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`next_attempt_at` integer,
	`delivered_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`approval_id`) REFERENCES `gateway_pending_approval`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `gateway_approval_destination`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_approval_decision_delivery_once` ON `gateway_approval_decision_delivery` (`approval_id`,`destination_id`);--> statement-breakpoint
CREATE INDEX `gateway_approval_decision_delivery_due` ON `gateway_approval_decision_delivery` (`status`,`next_attempt_at`);--> statement-breakpoint
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
ALTER TABLE `gateway_audit` ADD `approval` text;--> statement-breakpoint
ALTER TABLE `gateway_pending_approval` ADD `subject` text;--> statement-breakpoint
ALTER TABLE `gateway_pending_approval` ADD `edited_arguments` text;--> statement-breakpoint
ALTER TABLE `gateway_pending_approval` ADD `idempotency_key` text;--> statement-breakpoint
ALTER TABLE `gateway_pending_approval` ADD `claimed_at` integer;--> statement-breakpoint
ALTER TABLE `gateway_profile` ADD `approval_expiry_minutes` integer DEFAULT 1440;--> statement-breakpoint
ALTER TABLE `gateway_profile` ADD `subjects` text;--> statement-breakpoint
ALTER TABLE `connection` ADD `reconnect_reason` text;--> statement-breakpoint
ALTER TABLE `credential` ADD `claim` text;--> statement-breakpoint
ALTER TABLE `credential` ADD `claimed_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `iss_parameter_supported` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `secret_expires_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_flow` ADD `nonce` text;--> statement-breakpoint
ALTER TABLE `tool` ADD `destructive` integer;--> statement-breakpoint
ALTER TABLE `tool` ADD `idempotent` integer;