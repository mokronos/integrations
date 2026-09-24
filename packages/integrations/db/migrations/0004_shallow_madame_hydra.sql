ALTER TABLE `oauth_client` ADD `token_auth_method` text;--> statement-breakpoint
ALTER TABLE `oauth_client` DROP COLUMN `token_auth_methods`;