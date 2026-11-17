// mcp.ts — Model Context Protocol over Streamable HTTP at /mcp, modern era
// (2026-07-28 server/discover) with the legacy initialize handshake as fallback.
import {
  VIEWER_LOGIN,
  type Store, type Repo,
} from './store.ts';
import { repoJson, issueJson, pullJson, createIssueRecord, createPullRecord, doMerge } from './rest.ts';

export const MCP_VERSION = '2026-07-28';
const SERVER_NAME = 'makefun-git-forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function findRepo(store: Store, owner: string, repo: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repo);
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const full = typeof args.full_name === 'string' ? args.full_name : typeof args.repo_full_name === 'string' ? args.repo_full_name : null;
  if (full && full.includes('/')) {
    const [owner, repo] = full.split('/', 2);
    return { owner: owner ?? '', repo: repo ?? '' };
  }
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : typeof args.repository === 'string' ? args.repository : '';
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { result: Record<string, unknown>; rpcError?: { code: number; message: string } } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { result: {}, rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
  if (missing.length > 0) {
    return { result: toolResult(`Missing required argument: ${missing.join(', ')}`, true) };
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (/[^\w.-]/.test(repoName)) return { result: toolResult('Invalid repository name.', true) };
      const repo = store.createRepo(repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (repo === null) return { result: toolResult(`Repository ${repoName} already exists.`, true) };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const target = splitFullName(args);
      if (!target) return { result: toolResult('Missing repository owner or name.', true) };
      const repo = findRepo(store, target.owner, target.repo);
      if (!repo) return { result: toolResult(`Repository ${target.owner}/${target.repo} not found.`, true) };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const target = splitFullName(args);
      if (!target) return { result: toolResult('Missing repository owner or name.', true) };
      const repo = findRepo(store, target.owner, target.repo);
      if (!repo) return { result: toolResult(`Repository ${target.owner}/${target.repo} not found.`, true) };
      const r = createIssueRecord(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in r) return { result: toolResult(r.error, true) };
      return { result: toolResult(issueJson(repo, r.issue)) };
    }
    case 'list_issues': {
      const target = splitFullName(args);
      if (!target) return { result: toolResult('Missing repository owner or name.', true) };
      const repo = findRepo(store, target.owner, target.repo);
      if (!repo) return { result: toolResult(`Repository ${target.owner}/${target.repo} not found.`, true) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state).map((i) => issueJson(repo, i));
      return { result: toolResult(list) };
    }
    case 'create_pull_request': {
      const target = splitFullName(args);
      if (!target) return { result: toolResult('Missing repository owner or name.', true) };
      const repo = findRepo(store, target.owner, target.repo);
      if (!repo) return { result: toolResult(`Repository ${target.owner}/${target.repo} not found.`, true) };
      const head = String(args.head);
      const base = String(args.base);
      const r = createPullRecord(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      if ('error' in r) return { result: toolResult(r.error, true) };
      return { result: toolResult(pullJson(repo, r.pull)) };
    }
    case 'merge_pull_request': {
      const target = splitFullName(args);
      if (!target) return { result: toolResult('Missing repository owner or name.', true) };
      const repo = findRepo(store, target.owner, target.repo);
      if (!repo) return { result: toolResult(`Repository ${target.owner}/${target.repo} not found.`, true) };
      const number = Number(args.pull_number ?? args.number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return { result: toolResult(`Pull request #${number} not found.`, true) };
      const merged = doMerge(repo, pull);
      if (merged === null) return { result: toolResult(`Pull request #${number} is not mergeable.`, true) };
      return { result: toolResult({ merged: true, sha: merged.sha, number: pull.number, message: merged.message }) };
    }
    default:
      return { result: {}, rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

export interface McpResponse { status: number; contentType: string; body: string }

/** Handle one POST /mcp body (already read as text). */
export function handleMcp(store: Store, bodyText: string): McpResponse {
  const ok = (payload: unknown, status = 200): McpResponse => ({
    status, contentType: 'application/json', body: JSON.stringify(payload),
  });
  let doc: unknown;
  try {
    doc = JSON.parse(bodyText);
  } catch {
    return ok({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return ok({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, 400);
  }
  const req = doc as Record<string, unknown>;
  const id = (req.id ?? null) as string | number | null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) are answered with 202 and no body.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, contentType: 'application/json', body: '' };
  }

  const result = (value: unknown): McpResponse => ok({ jsonrpc: '2.0', id, result: value });
  const error = (code: number, message: string, status = 200): McpResponse =>
    ok({ jsonrpc: '2.0', id, error: { code, message } }, status);

  switch (method) {
    case 'server/discover':
      return result({
        supportedVersions: [MCP_VERSION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_VERSION;
      const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      return result({
        protocolVersion: known.includes(offered) ? offered : MCP_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const { result: toolRes, rpcError } = callTool(store, toolName, args);
      if (rpcError) return error(rpcError.code, rpcError.message);
      return result(toolRes);
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}
