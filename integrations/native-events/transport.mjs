import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_BODY = 262144;
const fail = (code) => Object.assign(new Error(code), { code });

// Deliberately IPv4-only for this first review candidate. IPv6 (including
// mapped IPv4) fails closed rather than depending on an incomplete classifier.
export function publicAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}

export function callbackURL(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('invalid_destination'); }
  // DNS hostnames only, HTTPS default port only, no embedded credentials.
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      url.port || isIP(url.hostname) || url.hostname.includes(':') ||
      !url.hostname.includes('.') || url.href.length > 4096) throw fail('invalid_destination');
  return url;
}

export function signature(secret, id, timestamp, body) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw fail('invalid_secret');
  const encoded = secret.slice(6), key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64') !== encoded) throw fail('invalid_secret');
  return 'v1,' + createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64');
}

// Dependencies are trusted host adapters, never request-supplied configuration.
export function createTransport({ resolve = lookup, request = https.request, now = Date.now,
  timeoutMs = 10000, maxResponse = 16384 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 ||
      !Number.isInteger(maxResponse) || maxResponse < 1 || maxResponse > 16384) throw fail('invalid_limits');
  return async function send({ url: value, secret, subscriptionId, id, body, authorize }) {
    const url = callbackURL(value);
    if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY) throw fail('payload_size');
    for (const field of [id, subscriptionId]) if (typeof field !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(field)) throw fail('invalid_id');
    if (typeof authorize !== 'function') throw fail('unauthorized');
    return new Promise((accept, reject) => {
      let req, responseStatus, settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) {
          req?.destroy();
          // A received HTTP status remains authoritative for delivery even when
          // its optional body cannot be read. Verification still rejects errors.
          const failure = fail(error);
          if (responseStatus !== undefined) failure.status = responseStatus;
          reject(failure);
        } else accept(result);
      };
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      (async () => {
        // Resolve afresh for every attempt and validate ALL returned addresses.
        const addresses = await resolve(url.hostname, { all: true, verbatim: true });
        if (!addresses.length || addresses.some(a => a.family !== 4 || !publicAddress(a.address))) throw fail('blocked_destination');
        if (!(await authorize())) throw fail('unauthorized');
        if (settled) return;
        const chosen = addresses[0];
        const timestamp = String(Math.floor(now() / 1000));
        req = request({ protocol: 'https:', hostname: url.hostname, port: 443,
          path: url.pathname + url.search, method: 'POST', agent: false,
          servername: url.hostname, rejectUnauthorized: true, maxHeaderSize: 16384,
          // Pin the socket's sole DNS result; TLS still verifies the original host.
          lookup: (_host, options, cb) => options?.all
            ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family),
          headers: { Host: url.host, 'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body), 'webhook-id': id,
            'webhook-timestamp': timestamp, 'webhook-signature': signature(secret, id, timestamp, body),
            'X-MCP-Subscription-Id': subscriptionId }
        }, res => {
          if (!Number.isInteger(res.statusCode) || res.statusCode < 200 || res.statusCode > 599) {
            res.destroy(); finish('network'); return;
          }
          responseStatus = res.statusCode;
          let length = 0; const chunks = [];
          res.on('data', chunk => {
            length += chunk.length;
            if (length > maxResponse) { res.destroy(); finish('response_size'); }
            else chunks.push(chunk);
          });
          res.on('error', () => finish('network'));
          res.on('aborted', () => finish('network'));
          res.on('end', () => finish(null, { status: responseStatus, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', () => finish('network'));
        req.end(body);
      })().catch(error => finish(['blocked_destination', 'unauthorized', 'invalid_secret'].includes(error.code) ? error.code : 'network'));
    });
  };
}

export async function verifyCallback(send, subscription, authorize) {
  const challenge = randomBytes(32).toString('hex');
  const result = await send({ ...subscription, subscriptionId: subscription.id,
    id: 'verify_' + randomBytes(16).toString('hex'),
    body: JSON.stringify({ type: 'verification', challenge }), authorize });
  let echoed;
  try { echoed = JSON.parse(result.body).challenge; } catch { throw fail('challenge_failed'); }
  if (result.status < 200 || result.status >= 300 || typeof echoed !== 'string' ||
      Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) ||
      !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))) throw fail('challenge_failed');
  return true;
}
