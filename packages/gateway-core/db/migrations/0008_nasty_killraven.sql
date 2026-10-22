ALTER TABLE `gateway_client` ADD `approval_group_window_minutes` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_pending_approval` ADD `group_id` text;--> statement-breakpoint
CREATE INDEX `gateway_pending_approval_group` ON `gateway_pending_approval` (`group_id`,`status`);--> statement-breakpoint
CREATE INDEX `gateway_pending_approval_open` ON `gateway_pending_approval` (`client_id`,`tool`,`status`);