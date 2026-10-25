CREATE TABLE `mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reply_message_id` text,
	`created_at` text NOT NULL,
	`replied_at` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mention_recipient_unique` ON `mentions` (`message_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `mention_agent_status_time` ON `mentions` (`agent_id`,`status`,`created_at`);