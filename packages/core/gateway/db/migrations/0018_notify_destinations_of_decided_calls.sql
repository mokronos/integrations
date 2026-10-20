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
CREATE INDEX `gateway_approval_decision_delivery_due` ON `gateway_approval_decision_delivery` (`status`,`next_attempt_at`);