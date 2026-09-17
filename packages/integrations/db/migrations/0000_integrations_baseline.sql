CREATE TABLE `connection` (
	`owner` text NOT NULL,
	`integration` text NOT NULL,
	`name` text NOT NULL,
	`template` text NOT NULL,
	`provider` text NOT NULL,
	`identity_label` text,
	`description` text,
	`oauth_client` text,
	`oauth_client_owner` text,
	`oauth_scope` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner`, `integration`, `name`),
	FOREIGN KEY (`integration`) REFERENCES `integration`(`slug`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `connection_by_integration` ON `connection` (`integration`,`owner`);--> statement-breakpoint
CREATE TABLE `credential` (
	`key` text PRIMARY KEY NOT NULL,
	`sealed` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `integration` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`endpoint` text,
	`spec_source` text,
	`spec_format` text,
	`base_url` text,
	`display_url` text,
	`auth_methods` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_client` (
	`owner` text NOT NULL,
	`slug` text NOT NULL,
	`integration` text NOT NULL,
	`client_id` text NOT NULL,
	`authorization_url` text NOT NULL,
	`token_url` text NOT NULL,
	`registration_endpoint` text,
	`issuer` text,
	`resource` text,
	`scopes` text DEFAULT '[]' NOT NULL,
	`token_auth_methods` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner`, `slug`)
);
--> statement-breakpoint
CREATE TABLE `oauth_flow` (
	`state` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`integration` text NOT NULL,
	`connection` text NOT NULL,
	`template` text NOT NULL,
	`client_owner` text NOT NULL,
	`client_slug` text NOT NULL,
	`code_verifier` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`resource` text,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spec_document` (
	`source` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool` (
	`address` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`integration` text NOT NULL,
	`connection` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`read_only` integer DEFAULT 0 NOT NULL,
	`input_schema` text,
	`output_schema` text,
	`call` text NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_by_connection` ON `tool` (`integration`,`owner`,`connection`);