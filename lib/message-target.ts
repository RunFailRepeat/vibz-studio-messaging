import { StudioError, StudioService, type Principal } from './studio';
import type { Message, MessageMention } from './types';

export type MessageTarget = { messageId: string; channelId?: string; rootId?: string };
export type ResolvedMessageTarget = { message: Message; root: Message };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,100}$/.test(value);

export function validateMessageTarget(input: MessageTarget): MessageTarget {
  if (!validId(input.messageId) || (input.channelId !== undefined && !validId(input.channelId)) ||
      (input.rootId !== undefined && !validId(input.rootId))) {
    throw new StudioError(400, 'Invalid message target.');
  }
  return input;
}

// Authorize before lookup. All admitted members share all rooms in this version;
// a future room ACL must also apply here before returning either message.
export async function resolveMessageTarget(db: D1Database, principal: Principal, input: MessageTarget): Promise<ResolvedMessageTarget> {
  await new StudioService(db).member(principal);
  const target = validateMessageTarget(input);
  const found = await db.prepare(`SELECT m.id AS target_id, r.id AS root_id
    FROM messages m JOIN channels c ON c.id=m.channel_id
    JOIN messages r ON r.id=COALESCE(m.parent_id,m.id)
    WHERE m.id=? AND r.parent_id IS NULL AND r.channel_id=m.channel_id
      AND (? IS NULL OR m.channel_id=?) AND (? IS NULL OR r.id=?)`)
    .bind(target.messageId, target.channelId ?? null, target.channelId ?? null, target.rootId ?? null, target.rootId ?? null)
    .first<{ target_id: string; root_id: string }>();
  if (!found) throw new StudioError(404, 'Message or its original thread is unavailable.', 'not_found');
  const rows = (await db.prepare(`SELECT m.*,
    (SELECT count(*) FROM messages reply WHERE reply.parent_id=m.id AND reply.channel_id=m.channel_id) AS reply_count
    FROM messages m WHERE m.id IN (?,?)`).bind(found.target_id, found.root_id).all<Record<string, unknown>>()).results;
  // A deletion between reads must not produce a partial or misleading target.
  if (!rows?.some(row => row.id === found.target_id) || !rows.some(row => row.id === found.root_id)) {
    throw new StudioError(404, 'Message or its original thread is unavailable.', 'not_found');
  }
  const receipts = (await db.prepare(`SELECT n.*, a.name AS agent_name FROM mentions n
    JOIN agents a ON a.id=n.agent_id WHERE n.message_id IN (?,?) ORDER BY n.created_at,n.id`)
    .bind(found.target_id, found.root_id).all<Record<string, unknown>>()).results ?? [];
  const shape = (row: Record<string, unknown>): Message => ({
    id: String(row.id), channelId: String(row.channel_id), parentId: row.parent_id === null ? null : String(row.parent_id),
    authorId: String(row.author_id), authorKind: row.author_kind as Message['authorKind'], authorName: String(row.author_name),
    body: String(row.body), createdAt: String(row.created_at), replyCount: Number(row.reply_count),
    mentions: receipts.filter(n => n.message_id === row.id).map(n => ({
      id: String(n.id), agentId: String(n.agent_id), agentName: String(n.agent_name), status: n.status as MessageMention['status'],
      replyMessageId: n.reply_message_id === null ? null : String(n.reply_message_id),
      createdAt: String(n.created_at), repliedAt: n.replied_at === null ? null : String(n.replied_at),
    })),
  });
  return { message: shape(rows.find(row => row.id === found.target_id)!), root: shape(rows.find(row => row.id === found.root_id)!) };
}
