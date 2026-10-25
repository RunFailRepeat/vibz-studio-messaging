import { body, failure, identity, json, sameOrigin, service } from '@/lib/server';
import { StudioError } from '@/lib/studio';

export const dynamic='force-dynamic';
async function route(request:Request){
  try{
    const url=new URL(request.url),path=url.pathname.replace(/^\/api\//,'').split('/').filter(Boolean),method=request.method;
    if(path.join('/')==='health'&&method==='GET')return json({ok:true,service:'Vibz Studio',version:'1.0.0'});
    const studio=service();
    if(path[0]==='agent'&&path.length===1&&method==='POST'){
      sameOrigin(request,false);
      const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]||'';
      const agent=await studio.authenticateAgent(token);
      return json(await studio.agentAction(agent,await body(request)));
    }
    const principal=identity(request);
    if(method!=='GET')sameOrigin(request);
    if(path[0]==='bootstrap'&&method==='POST')return json(await studio.bootstrap(principal));
    const member=await studio.member(principal);
    if(path[0]==='studio'&&method==='GET')return json(await studio.state(member));
    if(path[0]==='messages'&&path.length===1){
      if(method==='POST')return json(await studio.postMessage(member,await body(request)),201);
      if(method==='GET')return json(await studio.listMessages({channelId:url.searchParams.get('channelId')||'',parentId:url.searchParams.get('parentId')||undefined,before:url.searchParams.get('before')||undefined,after:url.searchParams.get('after')||undefined}));
    }
    if(path[0]==='search'&&method==='GET')return json(await studio.search(url.searchParams.get('q')||''));
    if(path[0]==='channels'&&method==='POST')return json(await studio.createChannel(member,await body(request)),201);
    if(path[0]==='tasks'&&method==='POST')return json(path.length===1?await studio.createTask(member,await body(request)):await studio.updateTask(member,path[1],await body(request)));
    if(path[0]==='members'&&path.length===2&&method==='POST')return json(await studio.updateMember(member,path[1],await body(request)));
    if(path[0]==='agents'&&path[2]==='token'&&path.length===3){
      if(method==='GET')return json(await studio.listTokens(member,path[1]));
      const data=await body(request);
      if(method==='POST')return json(await studio.mintToken(member,path[1],data.label),201);
      if(method==='DELETE')return json(await studio.revokeToken(member,path[1],data.tokenId));
    }
    if(path[0]==='export'&&method==='GET')return json(await studio.export(member),200,{'Content-Disposition':`attachment; filename="vibz-studio-${new Date().toISOString().slice(0,10)}.json"`});
    throw new StudioError(404,'That Studio operation does not exist.','not_found');
  }catch(error){return failure(error);}
}
export const GET=route;
export const POST=route;
export const DELETE=route;
