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
	FOREIGN KEY (`destination_id`) REFERENCES `gateway_approval_destination`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_approval_delivery_once` ON `gateway_approval_delivery` (`approval_id`,`destination_id`);--> statement-breakpoint
CREATE INDEX `gateway_approval_delivery_due` ON `gateway_approval_delivery` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `gateway_approval_destination` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`signing_secret` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `gateway_tenant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_approval_destination_name_tenant` ON `gateway_approval_destination` (`tenant_id`,`name`);--> statement-breakpoint
CREATE TABLE `gateway_client_approval_destination` (
	`client_id` text NOT NULL,
	`destination_id` text NOT NULL,
	PRIMARY KEY(`client_id`, `destination_id`),
	FOREIGN KEY (`client_id`) REFERENCES `gateway_client`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `gateway_approval_destination`(`id`) ON UPDATE no action ON DELETE cascade
);
