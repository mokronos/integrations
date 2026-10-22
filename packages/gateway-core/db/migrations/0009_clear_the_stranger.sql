CREATE TABLE `gateway_approval_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`approval_policy_id` text NOT NULL,
	`owner` text NOT NULL,
	`subject` text,
	`integration` text NOT NULL,
	`connection_name` text NOT NULL,
	`tool` text NOT NULL,
	`pattern` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`approval_policy_id`) REFERENCES `gateway_approval_policy`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gateway_approval_rule_route` ON `gateway_approval_rule` (`approval_policy_id`,`integration`,`connection_name`,`tool`);