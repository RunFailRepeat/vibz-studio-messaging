// No HTTP header/body fallback. Trusted host verifier must validate signature,
// issuer, revocation and audience against its configured trust source. No keys or
// verifier are provisioned here. Claims are not accepted from caller JSON.
const unauthorized=()=>Object.assign(new Error('unauthenticated'),{code:'unauthenticated'});
export function authenticatedHandler({verify,handle,audience,now=Date.now}) {
  if(typeof verify!=='function'||typeof handle!=='function'||typeof audience!=='string'||!audience) throw new Error('trusted_verifier_required');
  return async function authenticated(request) {
    let claims;
    try {claims=await verify(request);} catch {throw unauthorized();}
    if(!claims||typeof claims.subject!=='string'||!claims.subject||claims.subject.length>200||
      claims.audience!==audience||!Number.isSafeInteger(claims.expiresAt)||claims.expiresAt<=now()||claims.kind!=='human') throw unauthorized();
    // Copy only verified identity; raw headers/body remain untrusted route input.
    const principal=Object.freeze({userId:claims.subject,kind:'human'});
    return handle(principal,request);
  };
}
