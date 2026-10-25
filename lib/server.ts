import { env } from 'cloudflare:workers';
import { StudioError, StudioService, type Principal } from './studio';

export function service(){if(!env.DB)throw new StudioError(503,'The shared database is not available yet.','storage_unavailable');return new StudioService(env.DB);}
export function identity(request:Request):Principal{
  const userId=request.headers.get('oai-authenticated-user-id'),email=request.headers.get('oai-authenticated-user-email');
  if(!userId||!email)throw new StudioError(401,'Sign in with ChatGPT to use the Studio.','unauthenticated');
  let name=request.headers.get('oai-authenticated-user-full-name')||email;
  if(request.headers.get('oai-authenticated-user-full-name-encoding')==='percent-encoded-utf-8'){try{name=decodeURIComponent(name);}catch{name=email;}}
  return{userId,email,name};
}
export function sameOrigin(request:Request,required=true){
  const origin=request.headers.get('origin');
  if((required&&!origin)||(origin&&origin!==new URL(request.url).origin))throw new StudioError(403,'Use the Studio from its own browser tab.','origin_mismatch');
  const fetchSite=request.headers.get('sec-fetch-site');if(fetchSite==='cross-site')throw new StudioError(403,'Cross-site requests are not allowed.','origin_mismatch');
}
export async function body(request:Request){
  const type=request.headers.get('content-type')||'';if(!type.includes('application/json'))throw new StudioError(415,'Send JSON for this operation.');
  const length=Number(request.headers.get('content-length')||0);if(length>65536)throw new StudioError(413,'The request is too large.');
  const text=await request.text();if(text.length>65536)throw new StudioError(413,'The request is too large.');
  try{return JSON.parse(text);}catch{throw new StudioError(400,'The request is not valid JSON.');}
}
export function json(value:unknown,status=200,headers?:Record<string,string>){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...headers}});}
export function failure(error:unknown){
  if(error instanceof StudioError)return json({error:error.message,code:error.code},error.status);
  console.error('studio_request_failed',error instanceof Error?error.message:'Unknown error');
  return json({error:'The Studio could not complete that request. Your draft is safe; try again.',code:'internal_error'},500);
}
