import { body, identity, json, sameOrigin, service } from '@/lib/server';
import { StudioError } from '@/lib/studio';
import { mcpTools } from '@/lib/mcp-tools';

export const dynamic='force-dynamic';
export async function POST(request:Request){
  let id:unknown=null;
  try{
    sameOrigin(request,false);const message=await body(request);
    if(!message||typeof message!=='object'||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string')return json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid JSON-RPC request'}},400);
    id=message.id??null;
    const reply=(result:unknown)=>json({jsonrpc:'2.0',id,result});
    if(message.method==='server/discover')return reply({supportedVersions:['2026-07-28','2025-03-26','2024-11-05'],capabilities:{tools:{}},serverInfo:{name:'vibz-studio',version:'1.1.0'}});
    if(message.method==='initialize')return reply({protocolVersion:['2026-07-28','2025-03-26','2024-11-05'].includes(message.params?.protocolVersion)?message.params.protocolVersion:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'vibz-studio',version:'1.1.0'},instructions:'Four humans and four named agents. Use your own agent identity. During an active session, read studio_get_mentions and use studio_reply_to_mention for authorized substantive replies in their source threads. Pending means queued, not seen or delivered to an active model. Mentions do not wake closed sessions. Claim assigned tasks before execution, renew their leases with progress, and submit evidence for human review. Never claim a connected or completed state without actual receipts.'});
    if(message.method.startsWith('notifications/'))return new Response(null,{status:202,headers:{'Cache-Control':'no-store'}});
    if(message.method==='ping')return reply({});
    if(message.method==='tools/list')return reply({tools:mcpTools});
    if(message.method!=='tools/call')return json({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});
    const name=message.params?.name,args=message.params?.arguments??{};
    if(!mcpTools.some(t=>t.name===name))return json({jsonrpc:'2.0',id,error:{code:-32602,message:'Unknown tool'}});
    try{
      if(!args||typeof args!=='object'||Array.isArray(args))throw new StudioError(400,'Tool arguments must be an object.');
      const studio=service(),principal=identity(request);
      if(name==='studio_open_workspace')return reply({content:[{type:'text',text:JSON.stringify(await studio.bootstrap(principal))}],isError:false});
      const member=await studio.member(principal);let result:unknown;
      if(name==='studio_snapshot')result=await studio.state(member);
      else if(name==='studio_read_room')result=await studio.listMessages(args);
      else if(name==='studio_search')result=await studio.search(args.query);
      else if(name==='studio_create_task')result=await studio.createTask(member,args);
      else{
        const agent=await studio.mcpAgent(member,args.agentId);
        const actions:Record<string,string>={studio_post_message:'message',studio_get_mentions:'mentions',studio_reply_to_mention:'reply_mention',studio_agent_heartbeat:'heartbeat',studio_claim_task:'claim',studio_report_progress:'progress',studio_deliver_result:'deliver',studio_report_blocker:'block'};
        result=await studio.agentAction(agent,{...args,action:actions[name]});
      }
      return reply({content:[{type:'text',text:JSON.stringify(result)}],isError:false});
    }catch(error){const e=error instanceof StudioError?error:new StudioError(500,'The Studio could not complete this operation.','internal_error');return reply({content:[{type:'text',text:JSON.stringify({error:e.message,code:e.code,status:e.status})}],isError:true});}
  }catch(error){const e=error instanceof StudioError?error:new StudioError(500,'Request failed.');return json({jsonrpc:'2.0',id,error:{code:e.status===400?-32700:-32000,message:e.message}},e.status);}
}
export function GET(){return json({error:'Use a JSON-RPC POST to this MCP endpoint.'},405,{Allow:'POST'});}
