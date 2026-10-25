export function unsupportedWake(): Error & {code:'unsupported_transactional_d1_wakeup'};
export function prepareAuthoritativeBatch(db:D1Database,statements:D1PreparedStatement[],context:{messageId:string;nowMs:number}):D1PreparedStatement[];
export function commitAuthoritativeMessage(db:D1Database,statements:D1PreparedStatement[],context:{messageId:string;nowMs:number},options?:{localPrototype?:boolean}):Promise<D1Result[]>;
