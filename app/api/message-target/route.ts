import { env } from 'cloudflare:workers';
import { failure, identity, json } from '@/lib/server';
import { StudioError } from '@/lib/studio';
import { resolveMessageTarget } from '@/lib/message-target';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const principal = identity(request);
    if (!env.DB) throw new StudioError(503, 'The shared database is not available yet.', 'storage_unavailable');
    const params = new URL(request.url).searchParams;
    return json(await resolveMessageTarget(env.DB, principal, {
      messageId: params.get('messageId') ?? '',
      channelId: params.has('channelId') ? params.get('channelId')! : undefined,
      rootId: params.has('rootId') ? params.get('rootId')! : undefined,
    }));
  } catch (error) { return failure(error); }
}
