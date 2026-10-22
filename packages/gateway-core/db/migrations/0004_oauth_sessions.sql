CREATE TABLE `gateway_oauth_session` (
	`id` text PRIMARY KEY NOT NULL,
	`integration` text NOT NULL,
	`connection_name` text NOT NULL,
	`status_json` text NOT NULL,
	`request_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gateway_oauth_state` (
	`state` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL
);
