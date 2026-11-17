// app.ts — the forge's HTTP server: routing, auth, and body handling.
// One process serves git smart HTTP, REST v3, GraphQL and MCP from one store.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { Store } from './store.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  uploadPackAdvertisement, receivePackAdvertisement,
  parseV2Request, handleLsRefs, handleFetch, handleReceivePack,
} from './git.ts';

const MAX_BODY = 64 * 1024 * 1024;

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const authed = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const token = header.slice(7);
    if (token === '') return false;
    if (expectedToken !== '') return token === expectedToken;
    return true; // no token configured (local development): any non-empty bearer passes
  };

  const sendJson = (res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void => {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': store.nextRequestId(),
      ...(extra ?? {}),
    });
    res.end(body);
  };
  const sendBuffer = (res: ServerResponse, status: number, contentType: string, body: Buffer): void => {
    res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
    res.end(body);
  };
  const unauthorized = (res: ServerResponse): void => sendJson(res, 401, { message: 'Requires authentication' });
  const notFound = (res: ServerResponse): void => sendJson(res, 404, { message: 'Not Found' });

  const readBody = (req: IncomingMessage): Promise<Buffer> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      // ---- health probe (no auth)
      if (pathname === '/healthz') {
        if (method === 'GET') return sendJson(res, 200, { ok: true });
        return sendJson(res, 405, { message: 'Method Not Allowed' });
      }

      // ---- REST v3
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        if (!authed(req)) return unauthorized(res);
        const raw = await readBody(req);
        let body: unknown;
        let bodyParseError = false;
        if (raw.length > 0) {
          try { body = JSON.parse(raw.toString('utf8')); } catch { bodyParseError = true; }
        }
        const segments = pathname.replace(/^\/api\/v3\/?/, '').split('/').filter((s) => s !== '');
        const result = handleRest(store, {
          method,
          segments,
          query: url.searchParams,
          body,
          bodyParseError,
          host: req.headers.host ?? 'localhost',
        } satisfies RestRequest);
        const headers: Record<string, string> = { 'x-github-request-id': store.nextRequestId(), ...(result.headers ?? {}) };
        res.writeHead(result.status, { 'content-type': result.contentType, ...headers });
        res.end(result.body);
        return;
      }

      // ---- GraphQL
      if (pathname === '/api/graphql') {
        if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
        if (!authed(req)) return unauthorized(res);
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          return sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
        }
        const result = handleGraphQL(store, body);
        res.writeHead(result.status, { 'content-type': 'application/json', 'x-github-request-id': store.nextRequestId() });
        res.end(result.body);
        return;
      }

      // ---- MCP
      if (pathname === '/mcp') {
        if (method === 'DELETE') { res.writeHead(204); res.end(); return; }
        if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
        if (!authed(req)) return unauthorized(res);
        const raw = await readBody(req);
        const result = handleMcp(store, raw.toString('utf8'));
        res.writeHead(result.status, { 'content-type': result.contentType, 'x-github-request-id': store.nextRequestId() });
        res.end(result.body);
        return;
      }

      // ---- git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
      if (gitMatch) {
        if (!authed(req)) return unauthorized(res);
        const owner = decodeURIComponent(gitMatch[1]!);
        const repoName = decodeURIComponent(gitMatch[2]!);
        const rest = gitMatch[3] ?? '';
        const repo = store.getRepo(owner, repoName);
        if (repo === null) return notFound(res);
        if (method === 'GET' && rest === '/info/refs') {
          const service = url.searchParams.get('service');
          if (service === 'git-upload-pack') {
            return sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', uploadPackAdvertisement(repo));
          }
          if (service === 'git-receive-pack') {
            return sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', receivePackAdvertisement(repo));
          }
          return notFound(res);
        }
        if (method === 'POST' && rest === '/git-upload-pack') {
          const raw = await readBody(req);
          const { command, args } = parseV2Request(raw);
          if (command === 'ls-refs') {
            return sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, args));
          }
          if (command === 'fetch') {
            return sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleFetch(repo, args));
          }
          return sendJson(res, 400, { message: `Unknown command: ${command}` });
        }
        if (method === 'POST' && rest === '/git-receive-pack') {
          const raw = await readBody(req);
          return sendBuffer(res, 200, 'application/x-git-receive-pack-result', await handleReceivePack(repo, raw));
        }
        return notFound(res);
      }

      return notFound(res);
    } catch (e) {
      try {
        sendJson(res, 500, { message: e instanceof Error ? e.message : 'Internal Server Error' });
      } catch { /* socket already gone */ }
    }
  });

  return server;
}
