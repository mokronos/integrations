ALTER TABLE `connection` ADD `reconnect_reason` text;--> statement-breakpoint
ALTER TABLE `credential` ADD `claim` text;--> statement-breakpoint
ALTER TABLE `credential` ADD `claimed_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `iss_parameter_supported` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `secret_expires_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_flow` ADD `nonce` text;