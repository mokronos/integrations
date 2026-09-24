CREATE TABLE `blob` (
	`id` text PRIMARY KEY NOT NULL,
	`content_type` text NOT NULL,
	`filename` text,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blob_chunk` (
	`blob` text NOT NULL,
	`seq` integer NOT NULL,
	`data` blob NOT NULL,
	PRIMARY KEY(`blob`, `seq`)
);
