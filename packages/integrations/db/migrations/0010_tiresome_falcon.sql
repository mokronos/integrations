CREATE TABLE `event_type` (
	`integration` text NOT NULL,
	`owner` text NOT NULL,
	`connection` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`delivery` text NOT NULL,
	`input_schema` text,
	`payload_schema` text,
	`meta` text,
	`captured_at` integer NOT NULL,
	PRIMARY KEY(`integration`, `owner`, `connection`, `name`)
);
