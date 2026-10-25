export type MentionTarget={id:string;name:string};
export type MentionSpan={agentId:string;agentName:string;start:number;end:number};

/** Match exact known handles, outside code, URLs and email addresses. */
export function findAgentMentions(text:string,agents:MentionTarget[]):MentionSpan[]{
  const excluded:Array<[number,number]>=[];
  for(let i=0;i<text.length;i++){
    if(text[i]!=='`'&&!text.startsWith('~~~',i))continue;
    const symbol=text[i];let count=1;while(text[i+count]===symbol)count++;
    const delimiter=symbol.repeat(count),close=text.indexOf(delimiter,i+count);
    const lineEnd=text.indexOf('\n',i+count);
    const end=close>=0?close+count:count>=3?text.length:lineEnd>=0?lineEnd:text.length;
    excluded.push([i,end]);i=end-1;
  }
  const ignored=new RegExp('https?://[^\\s<>]+|www\\.[^\\s<>]+|[\\p{L}\\p{N}._%+\\-]+@[\\p{L}\\p{N}.\\-]+','giu');
  for(const match of text.matchAll(ignored))excluded.push([match.index!,match.index!+match[0].length]);
  const handles=new Map<string,MentionTarget>();
  for(const agent of agents){handles.set(agent.id.toLowerCase(),agent);handles.set(agent.name.replace(/\s+/g,'').toLowerCase(),agent);}
  const found:MentionSpan[]=[];
  const word=new RegExp('[\\p{L}\\p{N}_@.\\-]','u');
  for(const match of text.matchAll(/@[A-Za-z0-9_-]+/g)){
    const start=match.index!,end=start+match[0].length;
    if(start>0&&word.test(text[start-1]))continue;
    if(text[end]&&text[end]!=='.'&&word.test(text[end]))continue;
    if(text[end]==='.'&&word.test(text[end+1]??''))continue;
    let escapes=0;for(let i=start-1;i>=0&&text[i]==='\\';i--)escapes++;
    if(escapes%2===1)continue;
    if(excluded.some(([a,b])=>start<b&&end>a))continue;
    const agent=handles.get(match[0].slice(1).toLowerCase());
    if(agent)found.push({agentId:agent.id,agentName:agent.name,start,end});
  }
  return found;
}
