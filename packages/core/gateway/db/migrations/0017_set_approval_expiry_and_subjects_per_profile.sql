ALTER TABLE `gateway_profile` ADD `approval_expiry_minutes` integer DEFAULT 1440;--> statement-breakpoint
ALTER TABLE `gateway_profile` ADD `subjects` text;