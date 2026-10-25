import { integer, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const workspace = sqliteTable('workspace', {
  id:text('id').primaryKey(), name:text('name').notNull(), ownerId:text('owner_id').notNull(), createdAt:text('created_at').notNull(),
});
export const members = sqliteTable('members', {
  id:text('id').primaryKey(), name:text('name').notNull(), email:text('email').notNull(), userId:text('user_id'), role:text('role').notNull(), agentId:text('agent_id').notNull(), lastSeenAt:text('last_seen_at'),
}, t=>[uniqueIndex('member_email_unique').on(t.email),uniqueIndex('member_user_unique').on(t.userId)]);
export const agents = sqliteTable('agents', {
  id:text('id').primaryKey(), name:text('name').notNull(), ownerId:text('owner_id').notNull().references(()=>members.id), description:text('description').notNull(), status:text('status').notNull().default('idle'), detail:text('detail').notNull().default(''), lastSeenAt:text('last_seen_at'), connectedVia:text('connected_via'),
});
export const channels = sqliteTable('channels', {
  id:text('id').primaryKey(), name:text('name').notNull(), description:text('description').notNull(), createdAt:text('created_at').notNull(),
}, t=>[uniqueIndex('channel_name_unique').on(t.name)]);
export const messages = sqliteTable('messages', {
  id:text('id').primaryKey(), channelId:text('channel_id').notNull().references(()=>channels.id), parentId:text('parent_id'), authorId:text('author_id').notNull(), authorKind:text('author_kind').notNull(), authorName:text('author_name').notNull(), body:text('body').notNull(), requestKey:text('request_key').notNull(), requestHash:text('request_hash').notNull(), createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('message_request_unique').on(t.requestKey),index('message_channel_time').on(t.channelId,t.createdAt),index('message_parent_time').on(t.parentId,t.createdAt)]);
export const tasks = sqliteTable('tasks', {
  id:text('id').primaryKey(), channelId:text('channel_id').notNull().references(()=>channels.id), title:text('title').notNull(), brief:text('brief').notNull(), acceptance:text('acceptance').notNull(), assigneeAgentId:text('assignee_agent_id').references(()=>agents.id), createdBy:text('created_by').notNull().references(()=>members.id), state:text('state').notNull(), result:text('result'), evidence:text('evidence').notNull().default('[]'), reviewNote:text('review_note'), createdAt:text('created_at').notNull(), updatedAt:text('updated_at').notNull(), leaseId:text('lease_id'), leaseExpiresAt:text('lease_expires_at'), attempt:integer('attempt').notNull().default(0), requestKey:text('request_key').notNull(), requestHash:text('request_hash').notNull(), deliveryKey:text('delivery_key'), deliveryHash:text('delivery_hash'),
},t=>[uniqueIndex('task_request_unique').on(t.requestKey),index('task_queue').on(t.assigneeAgentId,t.state,t.createdAt)]);
export const activity = sqliteTable('activity', {
  id:text('id').primaryKey(), type:text('type').notNull(), actorId:text('actor_id').notNull(), actorName:text('actor_name').notNull(), taskId:text('task_id'), detail:text('detail').notNull(), createdAt:text('created_at').notNull(),
},t=>[index('activity_time').on(t.createdAt)]);
export const agentTokens = sqliteTable('agent_tokens', {
  id:text('id').primaryKey(), agentId:text('agent_id').notNull().references(()=>agents.id), label:text('label').notNull(), tokenHash:text('token_hash').notNull(), createdAt:text('created_at').notNull(), lastUsedAt:text('last_used_at'), revokedAt:text('revoked_at'),
},t=>[uniqueIndex('agent_token_hash_unique').on(t.tokenHash),index('agent_token_owner').on(t.agentId)]);
export const claims = sqliteTable('claims', {
  id:text('id').primaryKey(), agentId:text('agent_id').notNull().references(()=>agents.id), taskId:text('task_id'), leaseId:text('lease_id'), leaseExpiresAt:text('lease_expires_at'), processed:integer('processed').notNull().default(0), createdAt:text('created_at').notNull(),
});
export const mentions = sqliteTable('mentions', {
  id:text('id').primaryKey(),messageId:text('message_id').notNull().references(()=>messages.id),agentId:text('agent_id').notNull().references(()=>agents.id),status:text('status').notNull().default('pending'),replyMessageId:text('reply_message_id').references(()=>messages.id),createdAt:text('created_at').notNull(),repliedAt:text('replied_at'),
},t=>[uniqueIndex('mention_recipient_unique').on(t.messageId,t.agentId),index('mention_agent_status_time').on(t.agentId,t.status,t.createdAt)]);
