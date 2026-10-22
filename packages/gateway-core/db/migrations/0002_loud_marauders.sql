PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_gateway_approval_delivery` (
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
INSERT INTO `__new_gateway_approval_delivery`("id", "approval_id", "destination_id", "status", "attempts", "next_attempt_at", "delivered_at", "last_error") SELECT "id", "approval_id", "destination_id", "status", "attempts", "next_attempt_at", "delivered_at", "last_error" FROM `gateway_approval_delivery`;--> statement-breakpoint
DROP TABLE `gateway_approval_delivery`;--> statement-breakpoint
ALTER TABLE `__new_gateway_approval_delivery` RENAME TO `gateway_approval_delivery`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_approval_delivery_once` ON `gateway_approval_delivery` (`approval_id`,`destination_id`);--> statement-breakpoint
CREATE INDEX `gateway_approval_delivery_due` ON `gateway_approval_delivery` (`status`,`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `gateway_approval_destination` ADD `deleted_at` integer;