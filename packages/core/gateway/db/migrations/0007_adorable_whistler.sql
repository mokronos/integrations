ALTER TABLE `gateway_client` ADD `approval_method` text DEFAULT 'elicitation' NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_client` DROP COLUMN `approval_delivery`;