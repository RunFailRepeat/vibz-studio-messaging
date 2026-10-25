CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`task_id` text,
	`detail` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_time` ON `activity` (`created_at`);--> statement-breakpoint
CREATE TABLE `agent_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_token_hash_unique` ON `agent_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `agent_token_owner` ON `agent_tokens` (`agent_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`last_seen_at` text,
	`connected_via` text,
	FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_name_unique` ON `channels` (`name`);--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`task_id` text,
	`lease_id` text,
	`lease_expires_at` text,
	`processed` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`user_id` text,
	`role` text NOT NULL,
	`agent_id` text NOT NULL,
	`last_seen_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_email_unique` ON `members` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_user_unique` ON `members` (`user_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`parent_id` text,
	`author_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`request_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_request_unique` ON `messages` (`request_key`);--> statement-breakpoint
CREATE INDEX `message_channel_time` ON `messages` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `message_parent_time` ON `messages` (`parent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`brief` text NOT NULL,
	`acceptance` text NOT NULL,
	`assignee_agent_id` text,
	`created_by` text NOT NULL,
	`state` text NOT NULL,
	`result` text,
	`evidence` text DEFAULT '[]' NOT NULL,
	`review_note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`lease_id` text,
	`lease_expires_at` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`request_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`delivery_key` text,
	`delivery_hash` text,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_request_unique` ON `tasks` (`request_key`);--> statement-breakpoint
CREATE INDEX `task_queue` ON `tasks` (`assignee_agent_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` text NOT NULL
);
