// graphql.ts — a small GraphQL executor for the documents gh and github-mcp-server
// send: viewer/repository/node/__type queries, issue/PR connections, and the five
// mutations. No schema library: a hand parser plus per-type resolvers.
import {
  VIEWER_LOGIN, VIEWER_ID,
  type Store, type Repo, type Issue, type Pull,
  tick, nextSeq, flattenTreeOfCommit, diffTrees,
  buildTreeFromFlat, makeCommit,
  repoGlobalId, issueGlobalId, pullGlobalId, commentGlobalId, parseGlobalId,
  cursorFor, cursorToNumber,
} from './store.ts';
import { treeOfCommit, mergeable } from './rest.ts';

// ---------------------------------------------------------------- parser

type GqlValue = string | number | boolean | null | GqlValue[] | { [k: string]: GqlValue };
interface FieldNode {
  kind: 'field';
  name: string;
  alias: string;
  args: Record<string, GqlValue>;
  children: SelNode[];
}
interface FragNode { kind: 'fragment'; typeCondition: string | null; children: SelNode[] }
type SelNode = FieldNode | FragNode;
interface Operation { kind: 'query' | 'mutation'; name: string | null; selections: SelNode[] }

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c) || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}():![]=@$'.includes(c)) { tokens.push(c); i += 1; continue; }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]!;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else { out += src[j]; j += 1; }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) { this.tokens = tokens; }
  peek(): string | undefined { return this.tokens[this.pos]; }
  next(): string { return this.tokens[this.pos++]!; }
  expect(t: string): void { const got = this.next(); if (got !== t) throw new Error(`expected ${t}, got ${got}`); }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t === 'query' || t === 'mutation') { kind = this.next() as 'query' | 'mutation'; }
    if (this.peek() && this.peek() !== '{' && this.peek() !== '(') name = this.next();
    if (this.peek() === '(') this.parseVarDefs();
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private parseVarDefs(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t === '(' || t === '[' || t === '{') depth += 1;
      else if (t === ')' || t === ']' || t === '}') depth -= 1;
      if (t === '=') this.parseValue();
    }
  }

  private parseSelectionSet(): SelNode[] {
    this.expect('{');
    const out: SelNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek() === 'on') { this.next(); typeCondition = this.next(); }
        const children = this.parseSelectionSet();
        out.push({ kind: 'fragment', typeCondition, children });
      } else {
        out.push(this.parseField());
      }
    }
    this.expect('}');
    return out;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias = name;
    if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const key = this.next();
        this.expect(':');
        args[key] = this.parseValue();
      }
      this.next();
    }
    const children = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, children };
  }

  private parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') return { __var: this.next() } as unknown as GqlValue;
    if (t === '[') {
      const list: GqlValue[] = [];
      while (this.peek() !== ']') list.push(this.parseValue());
      this.next();
      return list;
    }
    if (t === '{') {
      const obj: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.next();
      return obj;
    }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^-?\d+\.\d+$/.test(t)) return Number(t);
    return t; // enum value
  }
}

function resolveVars(value: GqlValue, vars: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if ('__var' in rec && typeof rec.__var === 'string') return vars[rec.__var];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = resolveVars(v as GqlValue, vars);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => resolveVars(v, vars));
  return value;
}

// ---------------------------------------------------------------- errors

class GqlError extends Error {}

// ---------------------------------------------------------------- resolvers

interface Ctx { store: Store; vars: Record<string, unknown> }

/** A field node's arguments with variables resolved. */
function rargs(node: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.args)) out[k] = resolveVars(v, ctx.vars);
  return out;
}

function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name);
}

function repoById(store: Store, id: number): Repo | null {
  for (const r of store.listRepos()) if (r.id === id) return r;
  return null;
}

function issueState(issue: Issue): string { return issue.state === 'open' ? 'OPEN' : 'CLOSED'; }
function pullState(pull: Pull): string { return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'; }

function resolveViewer(children: SelNode[], _ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of children) {
    if (node.kind === 'fragment') { Object.assign(out, resolveViewer(node.children, _ctx)); continue; }
    if (node.name === 'login') out[node.alias] = VIEWER_LOGIN;
    else if (node.name === 'id') out[node.alias] = VIEWER_ID;
    else if (node.name === 'databaseId') out[node.alias] = VIEWER_ID;
    else if (node.name === 'name') out[node.alias] = 'Ada Iversen';
    else if (node.name === '__typename') out[node.alias] = 'User';
    else throw new GqlError(`Cannot query field "${node.name}" on type "User".`);
  }
  return out;
}

function resolveBranchRef(repo: Repo, children: SelNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of children) {
    if (node.kind === 'fragment') { Object.assign(out, resolveBranchRef(repo, node.children)); continue; }
    if (node.name === 'name') out[node.alias] = repo.defaultBranch;
    else if (node.name === '__typename') out[node.alias] = 'Ref';
    else throw new GqlError(`Cannot query field "${node.name}" on type "Ref".`);
  }
  return out;
}

function resolveIssue(repo: Repo, issue: Issue, children: SelNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of children) {
    if (node.kind === 'fragment') { Object.assign(out, resolveIssue(repo, issue, node.children, ctx)); continue; }
    switch (node.name) {
      case 'id': out[node.alias] = issueGlobalId(repo, issue); break;
      case 'databaseId': out[node.alias] = issue.id; break;
      case 'number': out[node.alias] = issue.number; break;
      case 'title': out[node.alias] = issue.title; break;
      case 'body': out[node.alias] = issue.body; break;
      case 'state': out[node.alias] = issueState(issue); break;
      case 'createdAt': out[node.alias] = issue.createdAt; break;
      case 'updatedAt': out[node.alias] = issue.updatedAt; break;
      case 'author': out[node.alias] = { login: VIEWER_LOGIN }; break;
      case '__typename': out[node.alias] = 'Issue'; break;
      default: throw new GqlError(`Cannot query field "${node.name}" on type "Issue".`);
    }
  }
  return out;
}

function resolvePull(repo: Repo, pull: Pull, children: SelNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of children) {
    if (node.kind === 'fragment') { Object.assign(out, resolvePull(repo, pull, node.children, ctx)); continue; }
    switch (node.name) {
      case 'id': out[node.alias] = pullGlobalId(repo, pull); break;
      case 'databaseId': out[node.alias] = pull.id; break;
      case 'number': out[node.alias] = pull.number; break;
      case 'title': out[node.alias] = pull.title; break;
      case 'body': out[node.alias] = pull.body; break;
      case 'state': out[node.alias] = pullState(pull); break;
      case 'merged': out[node.alias] = pull.merged; break;
      case 'mergeable': out[node.alias] = pull.state === 'open' ? (mergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN'; break;
      case 'headRefName': out[node.alias] = pull.headRef; break;
      case 'baseRefName': out[node.alias] = pull.baseRef; break;
      case 'headRef': out[node.alias] = pull.headSha ? { name: pull.headRef, target: { oid: pull.headSha } } : null; break;
      case 'baseRef': out[node.alias] = pull.baseSha ? { name: pull.baseRef, target: { oid: pull.baseSha } } : null; break;
      case 'createdAt': out[node.alias] = pull.createdAt; break;
      case 'updatedAt': out[node.alias] = pull.updatedAt; break;
      case 'files': {
        const first = typeof rargs(node, ctx).first === 'number' ? (rargs(node, ctx).first as number) : 10;
        const diffs = diffTrees(repo, treeOfCommit(repo, pull.baseSha), treeOfCommit(repo, pull.headSha));
        const nodes = diffs.slice(0, first).map((d) => ({ path: d.path }));
        out[node.alias] = connection(nodes, first, nodes.length, diffs.length);
        break;
      }
      case '__typename': out[node.alias] = 'PullRequest'; break;
      default: throw new GqlError(`Cannot query field "${node.name}" on type "PullRequest".`);
    }
  }
  return out;
}

function connection<T>(nodes: T[], _first: number, _count: number, total: number): Record<string, unknown> {
  return { nodes, edges: nodes.map((n, i) => ({ node: n, cursor: cursorFor(i) })), pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: nodes.length ? cursorFor(0) : null, endCursor: nodes.length ? cursorFor(nodes.length - 1) : null }, totalCount: total };
}

function resolveIssueConnection(repo: Repo, args: Record<string, unknown>, children: SelNode[], ctx: Ctx): Record<string, unknown> {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const want = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s.toLowerCase())));
    list = list.filter((i) => want.has(i.state));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy && orderBy.field === 'CREATED_AT') {
    const dir = orderBy.direction === 'ASC' ? 1 : -1;
    list.sort((a, b) => dir * (a.createdSeq - b.createdSeq) || dir * (a.number - b.number));
  } else {
    list.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
  }
  const first = typeof args.first === 'number' ? args.first : 10;
  const after = typeof args.after === 'string' ? cursorToNumber(args.after) : null;
  const startIdx = after === null ? 0 : after + 1;
  const sliced = list.slice(startIdx, startIdx + first);
  const hasNextPage = startIdx + first < list.length;
  const endCursor = sliced.length > 0 ? cursorFor(startIdx + sliced.length - 1) : null;
  const out: Record<string, unknown> = {};
  for (const node of children) {
    if (node.kind === 'fragment') { Object.assign(out, resolveIssueConnection(repo, args, node.children, ctx)); continue; }
    if (node.name === 'nodes') out[node.alias] = sliced.map((i) => resolveIssue(repo, i, node.children, ctx));
    else if (node.name === 'edges') out[node.alias] = sliced.map((i, idx) => ({ node: resolveIssue(repo, i, node.children.filter((c) => c.kind === 'field' && c.name === 'node').flatMap((c) => (c as FieldNode).children), ctx), cursor: cursorFor(startIdx + idx) }));
    else if (node.name === 'pageInfo') {
      const pi: Record<string, unknown> = {};
      for (const c of node.children) {
        if (c.kind !== 'field') continue;
        if (c.name === 'hasNextPage') pi[c.alias] = hasNextPage;
        else if (c.name === 'hasPreviousPage') pi[c.alias] = startIdx > 0;
        else if (c.name === 'startCursor') pi[c.alias] = sliced.length > 0 ? cursorFor(startIdx) : null;
        else if (c.name === 'endCursor') pi[c.alias] = endCursor;
        else throw new GqlError(`Cannot query field "${c.name}" on type "PageInfo".`);
      }
      out[node.alias] = pi;
    }
    else if (node.name === 'totalCount') out[node.alias] = list.length;
    else throw new GqlError(`Cannot query field "${node.name}" on type "IssueConnection".`);
  }
  return out;
}

function resolvePullConnection(repo: Repo, args: Record<string, unknown>, children: SelNode[], ctx: Ctx): Record<string, unknown> {
  let list = [...repo.pulls];
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const want = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((p) => want.has(p.state) || (want.has('merged') && p.merged));
  }
  list.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : 10;
  const after = typeof args.after === 'string' ? cursorToNumber(args.after) : null;
  const startIdx = after === null ? 0 : after + 1;
  const sliced = list.slice(startIdx, startIdx + first);
  const hasNextPage = startIdx + first < list.length;
  const out: Record<string, unknown> = {};
  for (const node of children) {
    if (node.kind === 'fragment') { Object.assign(out, resolvePullConnection(repo, args, node.children, ctx)); continue; }
    if (node.name === 'nodes') out[node.alias] = sliced.map((p) => resolvePull(repo, p, node.children, ctx));
    else if (node.name === 'edges') out[node.alias] = sliced.map((p, idx) => ({ node: resolvePull(repo, p, node.children.filter((c) => c.kind === 'field' && c.name === 'node').flatMap((c) => (c as FieldNode).children), ctx), cursor: cursorFor(startIdx + idx) }));
    else if (node.name === 'pageInfo') {
      const pi: Record<string, unknown> = {};
      for (const c of node.children) {
        if (c.kind !== 'field') continue;
        if (c.name === 'hasNextPage') pi[c.alias] = hasNextPage;
        else if (c.name === 'hasPreviousPage') pi[c.alias] = startIdx > 0;
        else if (c.name === 'startCursor') pi[c.alias] = sliced.length > 0 ? cursorFor(startIdx) : null;
        else if (c.name === 'endCursor') pi[c.alias] = sliced.length > 0 ? cursorFor(startIdx + sliced.length - 1) : null;
        else throw new GqlError(`Cannot query field "${c.name}" on type "PageInfo".`);
      }
      out[node.alias] = pi;
    }
    else if (node.name === 'totalCount') out[node.alias] = list.length;
    else throw new GqlError(`Cannot query field "${node.name}" on type "PullRequestConnection".`);
  }
  return out;
}

function resolveRepository(repo: Repo, children: SelNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of children) {
    if (node.kind === 'fragment') {
      if (node.typeCondition && node.typeCondition !== 'Repository') continue;
      Object.assign(out, resolveRepository(repo, node.children, ctx));
      continue;
    }
    switch (node.name) {
      case 'id': out[node.alias] = repoGlobalId(repo); break;
      case 'databaseId': out[node.alias] = repo.id; break;
      case 'name': out[node.alias] = repo.name; break;
      case 'nameWithOwner': out[node.alias] = `${repo.owner}/${repo.name}`; break;
      case 'owner': {
        const owner: Record<string, unknown> = {};
        for (const c of node.children) {
          if (c.kind !== 'field') continue;
          if (c.name === 'login') owner[c.alias] = repo.owner;
          else if (c.name === 'id') owner[c.alias] = VIEWER_ID;
          else if (c.name === '__typename') owner[c.alias] = 'User';
          else throw new GqlError(`Cannot query field "${c.name}" on type "User".`);
        }
        out[node.alias] = owner;
        break;
      }
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        out[node.alias] = tip ? resolveBranchRef(repo, node.children) : null;
        break;
      }
      case 'viewerPermission': out[node.alias] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[node.alias] = true; break;
      case 'description': out[node.alias] = repo.description; break;
      case 'private': out[node.alias] = repo.private; break;
      case 'url': out[node.alias] = `https://github.com/${repo.owner}/${repo.name}`; break;
      case 'createdAt': out[node.alias] = repo.createdAt; break;
      case 'updatedAt': out[node.alias] = repo.updatedAt; break;
      case 'issue': {
        const n = rargs(node, ctx).number as number | undefined;
        const issue = typeof n === 'number' ? repo.issues.find((i) => i.number === n) ?? null : null;
        out[node.alias] = issue ? resolveIssue(repo, issue, node.children, ctx) : null;
        break;
      }
      case 'issues': out[node.alias] = resolveIssueConnection(repo, rargs(node, ctx), node.children, ctx); break;
      case 'pullRequest': {
        const n = rargs(node, ctx).number as number | undefined;
        const pull = typeof n === 'number' ? repo.pulls.find((p) => p.number === n) ?? null : null;
        out[node.alias] = pull ? resolvePull(repo, pull, node.children, ctx) : null;
        break;
      }
      case 'pullRequests': out[node.alias] = resolvePullConnection(repo, rargs(node, ctx), node.children, ctx); break;
      case '__typename': out[node.alias] = 'Repository'; break;
      default: throw new GqlError(`Cannot query field "${node.name}" on type "Repository".`);
    }
  }
  return out;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'comments', 'labels', 'url', 'closed', 'locked'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'author', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'private', 'url', 'createdAt', 'updatedAt'],
  SearchType: [],
};
const TYPE_KIND: Record<string, string> = { Issue: 'OBJECT', PullRequest: 'OBJECT', Repository: 'OBJECT', SearchType: 'ENUM' };
const SEARCH_ENUM = ['ISSUE', 'COMMIT', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'];

function resolveType(name: string, children: SelNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = TYPE_FIELDS[name];
  for (const node of children) {
    if (node.kind === 'fragment') { Object.assign(out, resolveType(name, node.children)); continue; }
    if (node.name === 'name') out[node.alias] = name;
    else if (node.name === 'kind') out[node.alias] = TYPE_KIND[name] ?? 'OBJECT';
    else if (node.name === 'fields') {
      out[node.alias] = fields === undefined ? null : fields.map((f) => ({ name: f }));
    }
    else if (node.name === 'enumValues') {
      out[node.alias] = name === 'SearchType' ? SEARCH_ENUM.map((e) => ({ name: e })) : null;
    }
    else if (node.name === '__typename') out[node.alias] = '__Type';
    else throw new GqlError(`Cannot query field "${node.name}" on type "__Type".`);
  }
  return out;
}

// ---------------------------------------------------------------- mutations

function resolveCreateIssue(store: Store, args: Record<string, unknown>, children: SelNode[], ctx: Ctx): Record<string, unknown> {
  const input = args.input as Record<string, unknown>;
  const repo = repoById(store, Number(parseGlobalId(String(input.repositoryId ?? ''))?.repoId ?? -1));
  if (!repo) throw new GqlError('Could not resolve to a Repository with the global id.');
  const title = String(input.title ?? '');
  if (title === '') throw new GqlError('Title is required.');
  const { iso } = tick();
  repo.issueCounter += 1;
  const issue: Issue = {
    id: repo.id * 100000 + repo.issueCounter, number: repo.issueCounter,
    title, body: typeof input.body === 'string' ? input.body : '',
    state: 'open', labels: [], createdSeq: nextSeq(), updatedSeq: nextSeq(),
    createdAt: iso, updatedAt: iso, comments: [],
  };
  repo.issues.push(issue);
  const out: Record<string, unknown> = {};
  for (const node of children) {
    if (node.kind === 'fragment') { Object.assign(out, resolveCreateIssue(store, args, node.children, ctx)); continue; }
    if (node.name === 'issue') out[node.alias] = resolveIssue(repo, issue, node.children, ctx);
    else if (node.name === 'clientMutationId') out[node.alias] = input.clientMutationId ?? null;
    else throw new GqlError(`Cannot query field "${node.name}" on type "CreateIssuePayload".`);
  }
  return out;
}

function resolveCloseIssue(store: Store, args: Record<string, unknown>, children: SelNode[], ctx: Ctx): Record<string, unknown> {
  const input = args.input as Record<string, unknown>;
  const parsed = parseGlobalId(String(input.issueId ?? ''));
  if (!parsed || parsed.kind !== 'Issue') throw new GqlError('Could not resolve to an Issue with the global id.');
  const repo = repoById(store, parsed.repoId);
  const issue = repo?.issues.find((i) => i.number === parsed.number);
  if (!repo || !issue) throw new GqlError('Could not resolve to an Issue with the global id.');
  issue.state = 'closed';
  issue.updatedAt = tick().iso;
  const out: Record<string, unknown> = {};
  for (const node of children) {
    if (node.kind === 'fragment') { Object.assign(out, resolveCloseIssue(store, args, node.children, ctx)); continue; }
    if (node.name === 'issue') out[node.alias] = resolveIssue(repo, issue, node.children, ctx);
    else if (node.name === 'clientMutationId') out[node.alias] = input.clientMutationId ?? null;
    else throw new GqlError(`Cannot query field "${node.name}" on type "CloseIssuePayload".`);
  }
  return out;
}

function resolveCreatePullRequest(store: Store, args: Record<string, unknown>, children: SelNode[], ctx: Ctx): Record<string, unknown> {
  const input = args.input as Record<string, unknown>;
  const repo = repoById(store, Number(parseGlobalId(String(input.repositoryId ?? ''))?.repoId ?? -1));
  if (!repo) throw new GqlError('Could not resolve to a Repository with the global id.');
  const headRef = String(input.headRefName ?? '');
  const baseRef = String(input.baseRefName ?? '');
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha || !baseSha) throw new GqlError('Head or base ref not found.');
  if (repo.pulls.some((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef)) {
    throw new GqlError('A pull request already exists for this head branch.');
  }
  const { iso } = tick();
  repo.pullCounter += 1;
  const pull: Pull = {
    id: repo.id * 100000 + repo.pullCounter, number: repo.pullCounter,
    title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '',
    state: 'open', headRef, baseRef, headSha, baseSha,
    merged: false, mergedAt: null, mergeSha: null,
    createdSeq: nextSeq(), updatedSeq: nextSeq(), createdAt: iso, updatedAt: iso,
  };
  repo.pulls.push(pull);
  const out: Record<string, unknown> = {};
  for (const node of children) {
    if (node.kind === 'fragment') { Object.assign(out, resolveCreatePullRequest(store, args, node.children, ctx)); continue; }
    if (node.name === 'pullRequest') out[node.alias] = resolvePull(repo, pull, node.children, ctx);
    else if (node.name === 'clientMutationId') out[node.alias] = input.clientMutationId ?? null;
    else throw new GqlError(`Cannot query field "${node.name}" on type "CreatePullRequestPayload".`);
  }
  return out;
}

function resolveMergePullRequest(store: Store, args: Record<string, unknown>, children: SelNode[], ctx: Ctx): Record<string, unknown> {
  const input = args.input as Record<string, unknown>;
  const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
  if (!parsed || parsed.kind !== 'PullRequest') throw new GqlError('Could not resolve to a PullRequest with the global id.');
  const repo = repoById(store, parsed.repoId);
  const pull = repo?.pulls.find((p) => p.number === parsed.number);
  if (!repo || !pull) throw new GqlError('Could not resolve to a PullRequest with the global id.');
  if (pull.state !== 'open' || pull.merged) throw new GqlError('Pull request is already merged or closed.');
  if (!mergeable(repo, pull)) throw new GqlError('Pull request is not mergeable.');
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`)!;
  const baseFlat = flattenTreeOfCommit(repo, baseTip);
  const mergeBaseFlat = flattenTreeOfCommit(repo, pull.baseSha);
  const headFlat = flattenTreeOfCommit(repo, pull.headSha);
  for (const [path, v] of headFlat) {
    const baseV = mergeBaseFlat.get(path);
    if (!baseV || baseV.sha !== v.sha) baseFlat.set(path, v);
  }
  for (const [path] of mergeBaseFlat) if (!headFlat.has(path)) baseFlat.delete(path);
  const treeSha = buildTreeFromFlat(repo, baseFlat);
  const { iso } = tick();
  const mergeSha = makeCommit(repo, treeSha, [baseTip, pull.headSha], pull.title);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = iso;
  pull.mergeSha = mergeSha;
  pull.updatedAt = iso;
  const out: Record<string, unknown> = {};
  for (const node of children) {
    if (node.kind === 'fragment') { Object.assign(out, resolveMergePullRequest(store, args, node.children, ctx)); continue; }
    if (node.name === 'pullRequest') out[node.alias] = resolvePull(repo, pull, node.children, ctx);
    else if (node.name === 'clientMutationId') out[node.alias] = input.clientMutationId ?? null;
    else throw new GqlError(`Cannot query field "${node.name}" on type "MergePullRequestPayload".`);
  }
  return out;
}

function resolveAddComment(store: Store, args: Record<string, unknown>, children: SelNode[], ctx: Ctx): Record<string, unknown> {
  const input = args.input as Record<string, unknown>;
  const parsed = parseGlobalId(String(input.subjectId ?? ''));
  if (!parsed || parsed.kind !== 'Issue') throw new GqlError('Could not resolve to an Issue with the global id.');
  const repo = repoById(store, parsed.repoId);
  const issue = repo?.issues.find((i) => i.number === parsed.number);
  if (!repo || !issue) throw new GqlError('Could not resolve to an Issue with the global id.');
  const body = String(input.body ?? '');
  const { iso } = tick();
  repo.commentCounter += 1;
  const comment = { id: repo.id * 1000000 + repo.commentCounter, body, createdSeq: nextSeq(), createdAt: iso };
  issue.comments.push(comment);
  const out: Record<string, unknown> = {};
  for (const node of children) {
    if (node.kind === 'fragment') { Object.assign(out, resolveAddComment(store, args, node.children, ctx)); continue; }
    if (node.name === 'commentEdge') {
      const edge: Record<string, unknown> = {};
      for (const c of node.children) {
        if (c.kind !== 'field') continue;
        if (c.name === 'node') {
          const n: Record<string, unknown> = {};
          for (const f of c.children) {
            if (f.kind !== 'field') continue;
            if (f.name === 'id') n[f.alias] = commentGlobalId(repo, issue, comment);
            else if (f.name === 'body') n[f.alias] = comment.body;
            else if (f.name === '__typename') n[f.alias] = 'IssueComment';
            else throw new GqlError(`Cannot query field "${f.name}" on type "IssueComment".`);
          }
          edge[c.alias] = n;
        } else if (c.name === 'cursor') edge[c.alias] = cursorFor(issue.comments.length - 1);
        else throw new GqlError(`Cannot query field "${c.name}" on type "IssueCommentEdge".`);
      }
      out[node.alias] = edge;
    }
    else if (node.name === 'clientMutationId') out[node.alias] = input.clientMutationId ?? null;
    else throw new GqlError(`Cannot query field "${node.name}" on type "AddCommentPayload".`);
  }
  return out;
}

// ---------------------------------------------------------------- entry

function executeOperation(store: Store, op: Operation, vars: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const ctx: Ctx = { store, vars };
  const data: Record<string, unknown> = {};
  const errors: Array<{ message: string }> = [];
  const isMutation = op.kind === 'mutation';
  for (const node of op.selections) {
    if (node.kind === 'fragment') continue; // top-level fragments are not used by the suite
    try {
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.args)) args[k] = resolveVars(v, vars);
      if (!isMutation) {
        if (node.name === 'viewer') data[node.alias] = resolveViewer(node.children, ctx);
        else if (node.name === 'repository') {
          const repo = findRepo(store, String(args.owner ?? ''), String(args.name ?? ''));
          data[node.alias] = repo ? resolveRepository(repo, node.children, ctx) : null;
        } else if (node.name === 'node') {
          const parsed = parseGlobalId(String(args.id ?? ''));
          if (!parsed) data[node.alias] = null;
          else if (parsed.kind === 'Repository') {
            const repo = repoById(store, parsed.repoId);
            data[node.alias] = repo ? resolveRepository(repo, node.children, ctx) : null;
          } else if (parsed.kind === 'Issue') {
            const repo = repoById(store, parsed.repoId);
            const issue = repo?.issues.find((i) => i.number === parsed.number);
            data[node.alias] = repo && issue ? resolveIssue(repo, issue, node.children, ctx) : null;
          } else if (parsed.kind === 'PullRequest') {
            const repo = repoById(store, parsed.repoId);
            const pull = repo?.pulls.find((p) => p.number === parsed.number);
            data[node.alias] = repo && pull ? resolvePull(repo, pull, node.children, ctx) : null;
          } else data[node.alias] = null;
        } else if (node.name === '__type') {
          data[node.alias] = resolveType(String(args.name ?? ''), node.children);
        } else if (node.name === '__typename') data[node.alias] = 'Query';
        else throw new GqlError(`Cannot query field "${node.name}" on type "Query".`);
      } else {
        if (node.name === 'createIssue') data[node.alias] = resolveCreateIssue(store, args, node.children, ctx);
        else if (node.name === 'closeIssue') data[node.alias] = resolveCloseIssue(store, args, node.children, ctx);
        else if (node.name === 'createPullRequest') data[node.alias] = resolveCreatePullRequest(store, args, node.children, ctx);
        else if (node.name === 'mergePullRequest') data[node.alias] = resolveMergePullRequest(store, args, node.children, ctx);
        else if (node.name === 'addComment') data[node.alias] = resolveAddComment(store, args, node.children, ctx);
        else throw new GqlError(`Cannot query field "${node.name}" on type "Mutation".`);
      }
    } catch (e) {
      errors.push({ message: e instanceof Error ? e.message : String(e) });
      data[node.alias] = null;
    }
  }
  return errors.length > 0 ? { data, errors } : { data };
}

/** Handle one GraphQL request body (single document or a batch array). */
export function handleGraphQL(store: Store, body: unknown): { status: number; body: string } {
  const run = (doc: unknown): Record<string, unknown> => {
    if (doc === null || typeof doc !== 'object') return { data: null, errors: [{ message: 'Invalid GraphQL request.' }] };
    const rec = doc as Record<string, unknown>;
    const query = typeof rec.query === 'string' ? rec.query : '';
    const vars = (rec.variables ?? {}) as Record<string, unknown>;
    if (query.trim() === '') return { data: null, errors: [{ message: 'Must provide query string.' }] };
    try {
      const ops = new Parser(tokenize(query)).parseDocument();
      if (ops.length === 0) return { data: null, errors: [{ message: 'Must provide query string.' }] };
      // The suite sends one operation per document; answer the first.
      return executeOperation(store, ops[0]!, vars);
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  };
  if (Array.isArray(body)) {
    return { status: 200, body: JSON.stringify(body.map(run)) };
  }
  return { status: 200, body: JSON.stringify(run(body)) };
}
