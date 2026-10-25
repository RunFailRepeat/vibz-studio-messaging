import { z } from 'zod';
import type { Agent, Channel, Evidence, Member, Message, MessageMention, AgentMention, StudioState, Task, Activity } from './types';
import { findAgentMentions } from './mentions';

export class StudioError extends Error {
  constructor(public status:number, message:string, public code='invalid_request') { super(message); this.name='StudioError'; }
}
export type Principal = {userId:string;email:string;name:string};
export type AgentPrincipal = {id:string;name:string;ownerId:string;kind:'agent';via?:string;tokenId?:string};
type Row = Record<string,any>;
const OWNER_EMAIL='member1@example.invalid';
const MAX_LEASE_MS=300_000;
const ID=z.string().min(1).max(100).regex(/^[a-zA-Z0-9_:-]+$/);
const REQUEST_ID=z.string().min(8).max(120).regex(/^[a-zA-Z0-9_:-]+$/);
const TEXT=(n:number)=>z.string().trim().min(1).max(n);
const EVIDENCE=z.object({label:TEXT(1000),url:z.string().url().max(2048).refine(x=>/^https?:\/\//i.test(x),'Use an HTTP or HTTPS link.').optional()});
const messageInput=z.object({channelId:ID,body:TEXT(10000),parentId:ID.nullable().optional(),clientId:REQUEST_ID});
const taskInput=z.object({channelId:ID,title:TEXT(160),brief:TEXT(12000),acceptance:TEXT(4000),assigneeAgentId:ID.nullable(),clientId:REQUEST_ID});
const taskUpdate=z.discriminatedUnion('action',[
  z.object({action:z.literal('assign'),agentId:ID.nullable()}),
  z.object({action:z.literal('review'),decision:z.enum(['approve','changes_requested']),note:z.string().trim().max(4000)}),
  z.object({action:z.literal('cancel')}),
]);
const agentInput=z.discriminatedUnion('action',[
  z.object({action:z.literal('heartbeat'),status:z.enum(['idle','working','blocked']),detail:z.string().trim().max(2000).optional()}),
  z.object({action:z.literal('claim'),requestId:REQUEST_ID}),
  z.object({action:z.literal('progress'),taskId:ID,leaseId:ID,detail:TEXT(2000)}),
  z.object({action:z.literal('deliver'),taskId:ID,leaseId:ID,summary:TEXT(20000),evidence:z.array(EVIDENCE).min(1).max(12),requestId:REQUEST_ID}),
  z.object({action:z.literal('block'),taskId:ID,leaseId:ID,detail:TEXT(2000),requestId:REQUEST_ID}),
  z.object({action:z.literal('message'),channelId:ID,body:TEXT(10000),parentId:ID.nullable().optional(),requestId:REQUEST_ID}),
  z.object({action:z.literal('mentions'),limit:z.number().int().min(1).max(20).optional()}),
  z.object({action:z.literal('reply_mention'),mentionId:ID,body:TEXT(10000),requestId:REQUEST_ID}),
]);
function parse<T>(schema:z.ZodType<T>, input:unknown):T { const r=schema.safeParse(input); if(!r.success)throw new StudioError(400,r.error.issues.map(e=>`${e.path.join('.')||'Input'}: ${e.message}`).join('; ')); return r.data; }
function uid(prefix:string) {return `${prefix}_${crypto.randomUUID().replaceAll('-','')}`;}
export async function digest(value:string) { const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)); return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join(''); }
const memberShape=(r:Row):Member=>({id:r.id,name:r.name,email:r.email,role:r.role,agentId:r.agent_id,connected:!!r.user_id,lastSeenAt:r.last_seen_at??null});
const messageShape=(r:Row):Message=>({id:r.id,channelId:r.channel_id,parentId:r.parent_id,authorId:r.author_id,authorKind:r.author_kind,authorName:r.author_name,body:r.body,createdAt:r.created_at,replyCount:Number(r.reply_count||0)});
const taskShape=(r:Row):Task=>({id:r.id,channelId:r.channel_id,title:r.title,brief:r.brief,acceptance:r.acceptance,assigneeAgentId:r.assignee_agent_id,createdBy:r.created_by,state:r.state,result:r.result,evidence:JSON.parse(r.evidence||'[]'),reviewNote:r.review_note,createdAt:r.created_at,updatedAt:r.updated_at,leaseExpiresAt:r.lease_expires_at,attempt:Number(r.attempt)});
const channelShape=(r:Row):Channel=>({id:r.id,name:r.name,description:r.description,createdAt:r.created_at});
const activityShape=(r:Row):Activity=>({id:r.id,type:r.type,actorId:r.actor_id,actorName:r.actor_name,taskId:r.task_id,detail:r.detail,createdAt:r.created_at});
const mentionShape=(r:Row):MessageMention=>({id:r.id,agentId:r.agent_id,agentName:r.agent_name,status:r.status,replyMessageId:r.reply_message_id,createdAt:r.created_at,repliedAt:r.replied_at});

export class StudioService {
  private clock:()=>Date;
  constructor(private db:D1Database,options?:{now?:()=>Date}) { this.clock=options?.now??(()=>new Date()); }
  now(){return this.clock().toISOString();}
  private statement(sql:string,...bindings:any[]){return this.db.prepare(sql).bind(...bindings);}
  private async rows(sql:string,...bindings:any[]):Promise<Row[]>{return (await this.statement(sql,...bindings).all<Row>()).results||[];}
  private async one(sql:string,...bindings:any[]):Promise<Row|null>{return await this.statement(sql,...bindings).first<Row>();}
  private event(id:string,type:string,actor:{id:string;name:string},taskId:string|null,detail:string,when=this.now()){
    return this.statement('INSERT OR IGNORE INTO activity(id,type,actor_id,actor_name,task_id,detail,created_at) VALUES(?,?,?,?,?,?,?)',id,type,actor.id,actor.name,taskId,detail.slice(0,2500),when);
  }
  private conditionalEvent(id:string,type:string,actor:{id:string;name:string},taskId:string,detail:string,when:string,condition:string,...bindings:any[]){
    return this.statement(`INSERT OR IGNORE INTO activity(id,type,actor_id,actor_name,task_id,detail,created_at) SELECT ?,?,?,?,?,?,? WHERE ${condition}`,id,type,actor.id,actor.name,taskId,detail.slice(0,2500),when,...bindings);
  }
  private owner(member:Member){if(member.role!=='owner')throw new StudioError(403,'Only the workspace owner can change this setting.','forbidden');}
  private async channel(id:string){if(!await this.one('SELECT id FROM channels WHERE id=?',id))throw new StudioError(404,'Room not found.','not_found');}
  private async agentRow(id:string){const a=await this.one('SELECT * FROM agents WHERE id=?',id);if(!a)throw new StudioError(404,'Agent not found.','not_found');return a;}
  private async taskRow(id:string){const t=await this.one('SELECT * FROM tasks WHERE id=?',id);if(!t)throw new StudioError(404,'Task not found.','not_found');return t;}
  private async sameRequest(row:Row|null,hash:string){if(row&&row.request_hash!==hash)throw new StudioError(409,'This request ID was already used for different content.','idempotency_conflict');}
  private async decorateMessages(rows:Row[]):Promise<Message[]>{
    if(!rows.length)return[];
    const byMessage=new Map<string,MessageMention[]>();
    for(let offset=0;offset<rows.length;offset+=80){
      const ids=rows.slice(offset,offset+80).map(r=>r.id);
      const found=await this.rows(`SELECT n.*,a.name AS agent_name FROM mentions n JOIN agents a ON a.id=n.agent_id WHERE n.message_id IN (${ids.map(()=>'?').join(',')}) ORDER BY n.created_at,n.id`,...ids);
      for(const r of found){const values=byMessage.get(r.message_id)??[];values.push(mentionShape(r));byMessage.set(r.message_id,values);}
    }
    return rows.map(r=>({...messageShape(r),mentions:byMessage.get(r.id)??[]}));
  }

  async bootstrap(principal:Principal):Promise<StudioState>{
    const email=principal.email.trim().toLowerCase();
    if(!await this.one('SELECT id FROM workspace WHERE id=?','vibz')){
      if(email!==OWNER_EMAIL)throw new StudioError(403,'Member One needs to open the Studio first.','owner_setup_required');
      const now=this.now();
      const roster=[
        ['member1','Member One',OWNER_EMAIL,'owner','run'],
        ['member2','Member Two','member2@example.invalid','member','portfolio'],
        ['member3','Member Three','member3@example.invalid','member','coldfire'],
        ['member4','Member Four','member4@example.invalid','member','zingdot'],
      ];
      const dots=[
        ['run','Run','member1','Creative production, handoffs, and evidence review.'],
        ['portfolio','Portfolio','member2','Implementation, integration, and project coordination.'],
        ['coldfire','ColdFire','member3','Independent review, permissions, and recovery.'],
        ['zingdot','ZingDot','member4','Storytelling, teaching, and prompt clarity.'],
      ];
      await this.db.batch([
        this.statement('INSERT OR IGNORE INTO workspace(id,name,owner_id,created_at) VALUES(?,?,?,?)','vibz','Vibz Studio','member1',now),
        ...roster.map(r=>this.statement('INSERT OR IGNORE INTO members(id,name,email,role,agent_id) VALUES(?,?,?,?,?)',...r)),
        ...dots.map(r=>this.statement('INSERT OR IGNORE INTO agents(id,name,owner_id,description) VALUES(?,?,?,?)',...r)),
        ...[
          ['all-vibz-studio','all-vibz-studio','The shared room for the four of you and your agents.'],
          ['dot-coordination','dot-coordination','Agent handoffs, blockers, and evidence. Shared with the whole Studio.'],
          ['vibz-app','vibz-app','Build, test, and review the Vibz app.'],
        ].map(r=>this.statement('INSERT OR IGNORE INTO channels(id,name,description,created_at) VALUES(?,?,?,?)',...r,now)),
      ]);
    }
    const member=await this.member(principal);
    await this.statement('UPDATE members SET user_id=COALESCE(user_id,?),last_seen_at=? WHERE id=? AND (user_id IS NULL OR user_id=?)',principal.userId,this.now(),member.id,principal.userId).run();
    return this.state(await this.member(principal));
  }

  async member(principal:Principal):Promise<Member>{
    if(!principal.userId||!principal.email)throw new StudioError(401,'Sign in to your ChatGPT account to open the Studio.','unauthenticated');
    const row=await this.one('SELECT * FROM members WHERE user_id=? OR (email=? AND user_id IS NULL)',principal.userId,principal.email.trim().toLowerCase());
    if(!row)throw new StudioError(403,'This account is not one of the four Studio members. Ask Member One to set your expected sign-in email and share the Site with you.','not_a_member');
    return memberShape(row);
  }

  async state(member:Member):Promise<StudioState>{
    const [ms,as,cs,msgs,ts,ev]=await Promise.all([
      this.rows('SELECT * FROM members ORDER BY CASE role WHEN \'owner\' THEN 0 ELSE 1 END,id'),
      this.rows('SELECT a.*,(SELECT count(*) FROM mentions n WHERE n.agent_id=a.id AND n.status=\'pending\') AS pending_mentions FROM agents a ORDER BY CASE a.id WHEN \'run\' THEN 0 WHEN \'portfolio\' THEN 1 WHEN \'coldfire\' THEN 2 ELSE 3 END'),
      this.rows('SELECT * FROM channels ORDER BY created_at,id'),
      this.rows('SELECT m.*,(SELECT count(*) FROM messages r WHERE r.parent_id=m.id) AS reply_count FROM messages m ORDER BY m.created_at DESC,m.id DESC LIMIT 200'),
      this.rows('SELECT * FROM tasks ORDER BY updated_at DESC,id DESC LIMIT 300'),
      this.rows('SELECT * FROM activity ORDER BY created_at DESC,id DESC LIMIT 100'),
    ]);
    const now=this.now();
    return {workspace:{name:'Vibz Studio',maxHumans:4,ownerId:'member1'},viewer:member,members:ms.map(memberShape),agents:as.map(r=>({id:r.id,name:r.name,ownerId:r.owner_id,description:r.description,status:!r.last_seen_at?'not_connected':Date.parse(now)-Date.parse(r.last_seen_at)>90000?'offline':r.status,detail:r.detail,lastSeenAt:r.last_seen_at,connectedVia:r.connected_via,pendingMentions:Number(r.pending_mentions||0)} as Agent)),channels:cs.map(channelShape),messages:await this.decorateMessages(msgs.reverse()),tasks:ts.map(taskShape),activity:ev.map(activityShape),serverTime:now,messageLimit:200};
  }

  async postMessage(member:Member,input:unknown){
    const data=parse(messageInput,input);
    return {message:await this.writeMessage({id:member.id,name:member.name,kind:'human'},data)};
  }
  private async writeMessage(actor:{id:string;name:string;kind:'human'|'agent'},data:z.infer<typeof messageInput>):Promise<Message>{
    await this.channel(data.channelId);
    if(data.parentId){const p=await this.one('SELECT * FROM messages WHERE id=?',data.parentId);if(!p||p.channel_id!==data.channelId||p.parent_id)throw new StudioError(400,'Reply to a top-level message in the same room.');}
    const key=`${actor.kind}:${actor.id}:${data.clientId}`;
    const hash=await digest(JSON.stringify({channelId:data.channelId,body:data.body,parentId:data.parentId??null}));
    const existing=await this.one('SELECT * FROM messages WHERE request_key=?',key);await this.sameRequest(existing,hash);if(existing)return(await this.decorateMessages([existing]))[0];
    const id=uid('msg');const now=this.now();
    const roster=actor.kind==='human'?await this.rows('SELECT id,name FROM agents'):[];
    const targets=[...new Map(findAgentMentions(data.body,roster as {id:string;name:string}[]).map(m=>[m.agentId,m])).values()];
    await this.db.batch([
      this.statement('INSERT OR IGNORE INTO messages(id,channel_id,parent_id,author_id,author_kind,author_name,body,request_key,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,data.channelId,data.parentId??null,actor.id,actor.kind,actor.name,data.body,key,hash,now),
      this.statement('INSERT OR IGNORE INTO activity(id,type,actor_id,actor_name,task_id,detail,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE id=?)',`message:${id}`,'message',actor.id,actor.name,null,`${data.parentId?'Replied in':'Posted in'} #${data.channelId}`,now,id),
      ...targets.flatMap(target=>[
        this.statement('INSERT OR IGNORE INTO mentions(id,message_id,agent_id,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE id=?)',`${id}:${target.agentId}`,id,target.agentId,now,id),
        this.statement('INSERT OR IGNORE INTO activity(id,type,actor_id,actor_name,task_id,detail,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mentions WHERE id=?)',`mention:${id}:${target.agentId}`,'agent_mentioned',actor.id,actor.name,null,`Tagged ${target.agentName}; queued for its next active session.`,now,`${id}:${target.agentId}`),
      ]),
    ]);
    const saved=await this.one('SELECT * FROM messages WHERE request_key=?',key);await this.sameRequest(saved,hash);return(await this.decorateMessages([saved!]))[0];
  }

  async listMessages(input:{channelId:string;parentId?:string;before?:string;after?:string}){
    await this.channel(parse(ID,input.channelId));
    let sql='SELECT m.*,(SELECT count(*) FROM messages r WHERE r.parent_id=m.id) AS reply_count FROM messages m WHERE m.channel_id=?';
    const bindings:any[]=[input.channelId];const thread=!!input.parentId;
    if(thread){parse(ID,input.parentId);sql+=' AND m.parent_id=?';bindings.push(input.parentId);}else sql+=' AND m.parent_id IS NULL';
    const cursor=thread?input.after:input.before;
    if(cursor){const [date,id]=cursor.split('|');if(!date||!id||Number.isNaN(Date.parse(date)))throw new StudioError(400,'Invalid history cursor.');const op=thread?'>':'<';sql+=` AND (m.created_at ${op} ? OR (m.created_at=? AND m.id ${op} ?))`;bindings.push(date,date,id);}
    sql+=thread?' ORDER BY m.created_at ASC,m.id ASC LIMIT 101':' ORDER BY m.created_at DESC,m.id DESC LIMIT 101';
    const result=await this.rows(sql,...bindings);const hasMore=result.length>100;const page=result.slice(0,100);const last=page.at(-1);return{messages:await this.decorateMessages(thread?page:page.reverse()),hasMore,nextCursor:hasMore&&last?`${last.created_at}|${last.id}`:null};
  }
  async search(query:string){const q=parse(TEXT(200),query).replace(/[\\%_]/g,'\\$&');return{messages:await this.decorateMessages(await this.rows("SELECT m.*,(SELECT count(*) FROM messages r WHERE r.parent_id=m.id) AS reply_count FROM messages m WHERE m.body LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT 100",`%${q}%`))};}
  async createChannel(member:Member,input:unknown){const d=parse(z.object({name:z.string().trim().min(2).max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),description:z.string().trim().max(300)}),input);const id=uid('room'),now=this.now();try{await this.db.batch([this.statement('INSERT INTO channels(id,name,description,created_at) VALUES(?,?,?,?)',id,d.name,d.description,now),this.event(uid('evt'),'room_created',member,null,`Created #${d.name}`,now)]);}catch(e){if(await this.one('SELECT id FROM channels WHERE name=?',d.name))throw new StudioError(409,'A room with that name already exists.','conflict');throw e;}return{channel:{id,name:d.name,description:d.description,createdAt:now}};}

  async createTask(member:Member,input:unknown){
    const d=parse(taskInput,input);await this.channel(d.channelId);if(d.assigneeAgentId)await this.agentRow(d.assigneeAgentId);
    const key=`${member.id}:${d.clientId}`,hash=await digest(JSON.stringify({...d,clientId:undefined}));
    const existing=await this.one('SELECT * FROM tasks WHERE request_key=?',key);await this.sameRequest(existing,hash);if(existing)return{task:taskShape(existing)};
    const id=uid('task'),now=this.now();
    await this.db.batch([
      this.statement('INSERT OR IGNORE INTO tasks(id,channel_id,title,brief,acceptance,assignee_agent_id,created_by,state,created_at,updated_at,request_key,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,d.channelId,d.title,d.brief,d.acceptance,d.assigneeAgentId,member.id,d.assigneeAgentId?'queued':'inbox',now,now,key,hash),
      this.conditionalEvent(`created:${id}`,'task_created',member,id,`Created task: ${d.title}`,now,'EXISTS(SELECT 1 FROM tasks WHERE id=?)',id),
    ]);
    const saved=await this.one('SELECT * FROM tasks WHERE request_key=?',key);await this.sameRequest(saved,hash);return{task:taskShape(saved!)};
  }

  async updateTask(member:Member,id:string,input:unknown){
    parse(ID,id);const d=parse(taskUpdate,input),t=await this.taskRow(id),now=this.now();let statement:D1PreparedStatement;let detail:string;let kind:string;const eventId=uid('evt');
    if(d.action==='assign'){
      if(['done','cancelled'].includes(t.state))throw new StudioError(409,'Create a new task for completed or cancelled work.','invalid_transition');
      if(d.agentId)await this.agentRow(d.agentId);
      statement=this.statement('UPDATE tasks SET assignee_agent_id=?,state=?,lease_id=NULL,lease_expires_at=NULL,result=NULL,evidence=\'[]\',updated_at=? WHERE id=? AND state NOT IN (\'done\',\'cancelled\')',d.agentId,d.agentId?'queued':'inbox',now,id);
      detail=d.agentId?`Assigned ${t.title} to ${(await this.agentRow(d.agentId)).name}`:`Moved ${t.title} to the inbox`;kind='task_assigned';
    }else if(d.action==='review'){
      if(t.state!=='review')throw new StudioError(409,'Only delivered work awaiting review can be reviewed.','invalid_transition');
      if(d.decision==='changes_requested'&&!d.note)throw new StudioError(400,'Tell the agent what needs to change.');
      statement=this.statement('UPDATE tasks SET state=?,review_note=?,lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state=\'review\'',d.decision==='approve'?'done':t.assignee_agent_id?'queued':'inbox',d.note,now,id);
      detail=d.decision==='approve'?`Approved ${t.title}${d.note?`: ${d.note}`:''}`:`Requested changes to ${t.title}: ${d.note}`;kind=d.decision==='approve'?'task_approved':'changes_requested';
    }else{
      if(['done','cancelled'].includes(t.state))throw new StudioError(409,'This task is already closed.','invalid_transition');
      statement=this.statement('UPDATE tasks SET state=\'cancelled\',lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state NOT IN (\'done\',\'cancelled\')',now,id);detail=`Cancelled ${t.title}`;kind='task_cancelled';
    }
    const result=await this.db.batch([statement,this.conditionalEvent(eventId,kind,member,id,detail,now,'changes()>0')]);
    if(!result[0].meta.changes)throw new StudioError(409,'The task changed while you were reviewing it. Refresh and try again.','conflict');return{task:taskShape(await this.taskRow(id))};
  }

  async updateMember(member:Member,id:string,input:unknown){
    this.owner(member);parse(ID,id);const d=parse(z.object({email:z.string().trim().email().max(254)}),input);const row=await this.one('SELECT * FROM members WHERE id=?',id);if(!row)throw new StudioError(404,'Member not found.','not_found');if(id==='member1')throw new StudioError(400,'The owner identity is managed by your Site account.');
    const email=d.email.toLowerCase();if(row.email===email)return{member:memberShape(row)};
    if(await this.one('SELECT id FROM members WHERE email=? AND id<>?',email,id))throw new StudioError(409,'That email is already assigned to a member.','conflict');
    await this.db.batch([this.statement('UPDATE members SET email=?,user_id=NULL,last_seen_at=NULL WHERE id=?',email,id),this.statement('UPDATE agent_tokens SET revoked_at=? WHERE agent_id=? AND revoked_at IS NULL',this.now(),row.agent_id),this.statement('UPDATE tasks SET state=\'blocked\',lease_id=NULL,lease_expires_at=NULL,review_note=?,updated_at=? WHERE assignee_agent_id=? AND state=\'running\'','Agent owner sign-in email changed. Reconnect and reassign before continuing.',this.now(),row.agent_id),this.statement('UPDATE agents SET last_seen_at=NULL,status=\'idle\',detail=\'Owner sign-in changed; reconnect this agent.\',connected_via=NULL WHERE id=?',row.agent_id),this.event(uid('evt'),'member_updated',member,null,`Updated ${row.name}'s expected sign-in email; agent credentials revoked.`)]);
    return{member:memberShape((await this.one('SELECT * FROM members WHERE id=?',id))!)};
  }
  private async manageAgent(member:Member,id:string){const a=await this.agentRow(id);if(a.owner_id!==member.id&&member.role!=='owner')throw new StudioError(403,'You can only manage your own agent.','forbidden');return a;}
  async mintToken(member:Member,agentId:string,label:string){
    await this.manageAgent(member,agentId);parse(TEXT(80),label);const active=await this.one('SELECT count(*) AS n FROM agent_tokens WHERE agent_id=? AND revoked_at IS NULL',agentId);if(Number(active?.n)>=5)throw new StudioError(409,'Revoke an old connection before adding another (maximum five).','token_limit');
    const token=`vibz_${crypto.randomUUID().replaceAll('-','')}${crypto.randomUUID().replaceAll('-','')}`,tokenId=uid('token');
    await this.db.batch([this.statement('INSERT INTO agent_tokens(id,agent_id,label,token_hash,created_at) VALUES(?,?,?,?,?)',tokenId,agentId,label,await digest(token),this.now()),this.event(uid('evt'),'agent_token_created',member,null,`Created a connection for ${(await this.agentRow(agentId)).name}`)]);return{token,tokenId};
  }
  async listTokens(member:Member,agentId:string){await this.manageAgent(member,agentId);return{tokens:(await this.rows('SELECT id,label,created_at,last_used_at,revoked_at FROM agent_tokens WHERE agent_id=? ORDER BY created_at DESC LIMIT 50',agentId)).map(r=>({id:r.id,label:r.label,createdAt:r.created_at,lastUsedAt:r.last_used_at,revokedAt:r.revoked_at}))};}
  async revokeToken(member:Member,agentId:string,tokenId:string){await this.manageAgent(member,agentId);await this.db.batch([this.statement('UPDATE agent_tokens SET revoked_at=? WHERE id=? AND agent_id=? AND revoked_at IS NULL',this.now(),tokenId,agentId),this.event(uid('evt'),'agent_token_revoked',member,null,`Revoked an agent connection for ${(await this.agentRow(agentId)).name}`)]);return{ok:true};}
  async authenticateAgent(token:string):Promise<AgentPrincipal>{
    if(!/^vibz_[a-f0-9]{64}$/.test(token))throw new StudioError(401,'A valid agent token is required.','invalid_agent_token');
    const row=await this.one('SELECT a.*,t.id AS token_id FROM agent_tokens t JOIN agents a ON a.id=t.agent_id WHERE t.token_hash=? AND t.revoked_at IS NULL',await digest(token));if(!row)throw new StudioError(401,'Agent connection is missing or revoked.','invalid_agent_token');
    await this.statement('UPDATE agent_tokens SET last_used_at=? WHERE id=? AND revoked_at IS NULL',this.now(),row.token_id).run();return{id:row.id,name:row.name,ownerId:row.owner_id,kind:'agent',via:'Local bridge',tokenId:row.token_id};
  }
  async mcpAgent(member:Member,agentId?:string):Promise<AgentPrincipal>{
    const a=await this.agentRow(agentId??member.agentId);if(a.owner_id!==member.id)throw new StudioError(403,'MCP calls can act only as your own agent.','forbidden');return{id:a.id,name:a.name,ownerId:a.owner_id,kind:'agent',via:'ChatGPT / Codex'};
  }
  async getMentions(agent:AgentPrincipal,limit=20):Promise<{mentions:AgentMention[]}>{
    await this.verifyAgent(agent);parse(z.number().int().min(1).max(20),limit);
    const pending=await this.rows("SELECT * FROM mentions WHERE agent_id=? AND status='pending' ORDER BY created_at,id LIMIT ?",agent.id,limit);
    const result:AgentMention[]=[];
    for(const n of pending){
      const source=await this.one('SELECT * FROM messages WHERE id=?',n.message_id);if(!source)continue;
      const root=source.parent_id?await this.one('SELECT * FROM messages WHERE id=?',source.parent_id):source;if(!root)continue;
      const context=await this.rows('SELECT * FROM messages WHERE id=? OR parent_id=? ORDER BY created_at DESC,id DESC LIMIT 20',root.id,root.id);
      const [message,rootMessage]=await this.decorateMessages([source,root]);
      result.push({id:n.id,status:n.status,agentId:n.agent_id,channelId:source.channel_id,message,rootMessage,context:await this.decorateMessages(context.reverse()),createdAt:n.created_at});
    }
    return{mentions:result};
  }
  async replyToMention(agent:AgentPrincipal,input:unknown):Promise<{message:Message;mention:MessageMention}>{
    await this.verifyAgent(agent);
    const d=parse(z.object({mentionId:ID,body:TEXT(10000),requestId:REQUEST_ID}),input);
    const mention=await this.one('SELECT n.*,a.name AS agent_name FROM mentions n JOIN agents a ON a.id=n.agent_id WHERE n.id=?',d.mentionId);
    if(!mention)throw new StudioError(404,'Mention not found.','not_found');
    if(mention.agent_id!==agent.id)throw new StudioError(403,'This mention is addressed to another agent.','forbidden');
    const source=(await this.one('SELECT * FROM messages WHERE id=?',mention.message_id))!;
    const parentId=source.parent_id??source.id,key=`agent:${agent.id}:${d.requestId}`;
    const hash=await digest(JSON.stringify({mentionId:d.mentionId,channelId:source.channel_id,parentId,body:d.body}));
    const previous=await this.one('SELECT * FROM messages WHERE request_key=?',key);
    await this.sameRequest(previous,hash);
    if(previous){
      const current=(await this.one('SELECT n.*,a.name AS agent_name FROM mentions n JOIN agents a ON a.id=n.agent_id WHERE n.id=?',d.mentionId))!;
      if(current.reply_message_id!==previous.id)throw new StudioError(409,'This request ID was used for another operation.','idempotency_conflict');
      return{message:(await this.decorateMessages([previous]))[0],mention:mentionShape(current)};
    }
    if(mention.status==='replied')throw new StudioError(409,'This mention already has an agent reply.','mention_already_replied');
    const id=uid('msg'),now=this.now();
    await this.db.batch([
      this.statement("INSERT OR IGNORE INTO messages(id,channel_id,parent_id,author_id,author_kind,author_name,body,request_key,request_hash,created_at) SELECT ?,?,?,?,'agent',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mentions WHERE id=? AND agent_id=? AND status='pending')",id,source.channel_id,parentId,agent.id,agent.name,d.body,key,hash,now,d.mentionId,agent.id),
      this.statement("UPDATE mentions SET status='replied',reply_message_id=?,replied_at=? WHERE id=? AND agent_id=? AND status='pending' AND EXISTS(SELECT 1 FROM messages WHERE id=?)",id,now,d.mentionId,agent.id,id),
      this.statement("INSERT OR IGNORE INTO activity(id,type,actor_id,actor_name,task_id,detail,created_at) SELECT ?,'mention_replied',?,?,NULL,?,? WHERE EXISTS(SELECT 1 FROM mentions WHERE id=? AND reply_message_id=?)",`mention-reply:${d.mentionId}`,agent.id,agent.name,`${agent.name} replied to a mention in #${source.channel_id}.`,now,d.mentionId,id),
    ]);
    const saved=await this.one('SELECT * FROM messages WHERE request_key=?',key);await this.sameRequest(saved,hash);
    const current=(await this.one('SELECT n.*,a.name AS agent_name FROM mentions n JOIN agents a ON a.id=n.agent_id WHERE n.id=?',d.mentionId))!;
    if(!saved||current.reply_message_id!==saved.id)throw new StudioError(409,'Another session already replied to this mention.','mention_already_replied');
    await this.presence(agent,'idle','Replied to a mention.',now).run();
    return{message:(await this.decorateMessages([saved]))[0],mention:mentionShape(current)};
  }
  private async verifyAgent(agent:AgentPrincipal){
    if(agent.kind!=='agent')throw new StudioError(403,'Agent identity required.','forbidden');
    if(agent.tokenId&&!await this.one('SELECT id FROM agent_tokens WHERE id=? AND agent_id=? AND revoked_at IS NULL',agent.tokenId,agent.id))throw new StudioError(401,'Agent connection was revoked.','invalid_agent_token');
  }
  private presence(agent:AgentPrincipal,status:string,detail:string,now:string){return this.statement('UPDATE agents SET status=?,detail=?,last_seen_at=?,connected_via=? WHERE id=?',status,detail.slice(0,2000),now,agent.via??'Agent API',agent.id);}

  async agentAction(agent:AgentPrincipal,input:unknown):Promise<any>{
    await this.verifyAgent(agent);const d=parse(agentInput,input);const now=this.now();
    if(d.action==='mentions')return this.getMentions(agent,d.limit);
    if(d.action==='reply_mention')return this.replyToMention(agent,d);
    if(d.action==='heartbeat'){
      const a=await this.agentRow(agent.id);const first=!a.last_seen_at;const commands=[this.presence(agent,d.status,d.detail??'',now)];if(first)commands.push(this.event(uid('evt'),'agent_connected',agent,null,`${agent.name} sent its first authenticated heartbeat.`,now));await this.db.batch(commands);return{ok:true,agentId:agent.id,serverTime:now};
    }
    if(d.action==='message'){const message=await this.writeMessage({...agent,kind:'agent'},{channelId:d.channelId,body:d.body,parentId:d.parentId??null,clientId:d.requestId});await this.presence(agent,'idle','Posted a room update.',now).run();return{message};}
    if(d.action==='claim'){
      const key=`${agent.id}:${d.requestId}`,leaseId=uid('lease'),expires=new Date(Date.parse(now)+MAX_LEASE_MS).toISOString();
      await this.db.batch([
        this.statement('INSERT OR IGNORE INTO claims(id,agent_id,created_at) VALUES(?,?,?)',key,agent.id,now),
        this.statement("UPDATE tasks SET state='running',lease_id=?,lease_expires_at=?,updated_at=?,attempt=attempt+1 WHERE id=(SELECT id FROM tasks WHERE assignee_agent_id=? AND (state='queued' OR (state='running' AND lease_expires_at<=?)) ORDER BY created_at,id LIMIT 1) AND EXISTS(SELECT 1 FROM claims WHERE id=? AND processed=0) AND NOT EXISTS(SELECT 1 FROM tasks WHERE assignee_agent_id=? AND state='running' AND lease_expires_at>?)",leaseId,expires,now,agent.id,now,key,agent.id,now),
        this.statement('UPDATE claims SET task_id=(SELECT id FROM tasks WHERE lease_id=?),lease_id=(SELECT lease_id FROM tasks WHERE lease_id=?),lease_expires_at=(SELECT lease_expires_at FROM tasks WHERE lease_id=?),processed=1 WHERE id=? AND processed=0',leaseId,leaseId,leaseId,key),
        this.statement("INSERT OR IGNORE INTO activity(id,type,actor_id,actor_name,task_id,detail,created_at) SELECT ?,'task_claimed',?,?,id,'Started ' || title || ' (attempt ' || attempt || ')',? FROM tasks WHERE lease_id=?",`claim:${leaseId}`,agent.id,agent.name,now,leaseId),
      ]);
      const claim=(await this.one('SELECT * FROM claims WHERE id=?',key))!;
      if(!claim.task_id){await this.presence(agent,'idle','Connected; waiting for assigned work.',now).run();return{task:null};}
      const task=await this.taskRow(claim.task_id);const active=task.lease_id===claim.lease_id&&task.state==='running'&&task.lease_expires_at>now;
      if(active)await this.presence(agent,'working',`Working on ${task.title}`,now).run();
      return{task:taskShape(task),leaseId:claim.lease_id,leaseExpiresAt:task.lease_id===claim.lease_id?task.lease_expires_at:claim.lease_expires_at,active};
    }
    const t=await this.taskRow(d.taskId);
    if(t.assignee_agent_id!==agent.id)throw new StudioError(403,'This task is assigned to another agent.','forbidden');
    let key:string|null=null,hash:string|null=null;
    if(d.action==='deliver'||d.action==='block'){
      key=`${agent.id}:${d.requestId}`;hash=await digest(JSON.stringify(d));
      if(t.delivery_key===key){if(t.delivery_hash!==hash)throw new StudioError(409,'This request ID was used with different content.','idempotency_conflict');return{task:taskShape(t)};}
    }
    if(t.state!=='running'||t.lease_id!==d.leaseId||!t.lease_expires_at||t.lease_expires_at<=now)throw new StudioError(409,'This task lease expired or changed. Stop work and claim again.','lease_lost');
    if(d.action==='progress'){
      const expires=new Date(Date.parse(now)+MAX_LEASE_MS).toISOString();
      const result=await this.db.batch([
        this.statement("UPDATE tasks SET lease_expires_at=?,updated_at=? WHERE id=? AND assignee_agent_id=? AND state='running' AND lease_id=? AND lease_expires_at>?",expires,now,d.taskId,agent.id,d.leaseId,now),
        this.conditionalEvent(uid('evt'),'task_progress',agent,d.taskId,d.detail,now,'changes()>0'),
      ]);if(!result[0].meta.changes)throw new StudioError(409,'The task lease changed.','lease_lost');await this.presence(agent,'working',d.detail,now).run();return{ok:true,leaseExpiresAt:expires};
    }
    if(d.action==='deliver'){
      const result=await this.db.batch([
        this.statement("UPDATE tasks SET state='review',result=?,evidence=?,lease_id=NULL,lease_expires_at=NULL,delivery_key=?,delivery_hash=?,updated_at=? WHERE id=? AND assignee_agent_id=? AND state='running' AND lease_id=? AND lease_expires_at>?",d.summary,JSON.stringify(d.evidence),key,hash,now,d.taskId,agent.id,d.leaseId,now),
        this.conditionalEvent(`delivery:${d.leaseId}`,'task_delivered',agent,d.taskId,`Ready for human review: ${t.title}`,now,'changes()>0'),
      ]);if(!result[0].meta.changes){const current=await this.taskRow(d.taskId);if(current.delivery_key===key&&current.delivery_hash===hash)return{task:taskShape(current)};throw new StudioError(409,'The task lease changed before delivery.','lease_lost');}
      await this.presence(agent,'idle',`Delivered ${t.title}; waiting for human review.`,now).run();return{task:taskShape(await this.taskRow(d.taskId))};
    }
    const result=await this.db.batch([
      this.statement("UPDATE tasks SET state='blocked',review_note=?,lease_id=NULL,lease_expires_at=NULL,delivery_key=?,delivery_hash=?,updated_at=? WHERE id=? AND assignee_agent_id=? AND state='running' AND lease_id=? AND lease_expires_at>?",d.detail,key,hash,now,d.taskId,agent.id,d.leaseId,now),
      this.conditionalEvent(`blocked:${d.leaseId}`,'task_blocked',agent,d.taskId,d.detail,now,'changes()>0'),
    ]);if(!result[0].meta.changes){const current=await this.taskRow(d.taskId);if(current.delivery_key===key&&current.delivery_hash===hash)return{task:taskShape(current)};throw new StudioError(409,'The task lease changed.','lease_lost');}await this.presence(agent,'blocked',d.detail,now).run();return{task:taskShape(await this.taskRow(d.taskId))};
  }

  async export(member:Member){
    const [ms,as,cs,msgs,ts,ev,ns]=await Promise.all([this.rows('SELECT * FROM members'),this.rows('SELECT * FROM agents'),this.rows('SELECT * FROM channels'),this.rows('SELECT * FROM messages ORDER BY created_at,id LIMIT 50000'),this.rows('SELECT * FROM tasks ORDER BY created_at,id LIMIT 10000'),this.rows('SELECT * FROM activity ORDER BY created_at,id LIMIT 50000'),this.rows('SELECT n.*,a.name AS agent_name FROM mentions n JOIN agents a ON a.id=n.agent_id ORDER BY n.created_at,n.id LIMIT 50000')]);
    return{format:'vibz-studio-export-v1',exportedAt:this.now(),exportedBy:member.name,workspace:{name:'Vibz Studio'},members:ms.map(memberShape),agents:as.map(r=>({id:r.id,name:r.name,ownerId:r.owner_id,description:r.description})),channels:cs.map(channelShape),messages:msgs.map(messageShape),tasks:ts.map(taskShape),activity:ev.map(activityShape),mentions:ns.map(r=>({...mentionShape(r),messageId:r.message_id})),limits:{messages:50000,tasks:10000,events:50000,mentions:50000},truncated:msgs.length===50000||ts.length===10000||ev.length===50000||ns.length===50000};
  }
}
