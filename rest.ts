// rest.ts — GitHub REST v3 surface under /api/v3, pure routing over the store.
// Returns {status, contentType, body, headers}; app.ts does the socket work.
import { Buffer } from 'node:buffer';
import {
  VIEWER_LOGIN, VIEWER_ID, VIEWER_EMAIL, ZERO_OID,
  type Store, type Repo, type Issue, type Pull,
  tick, nextSeq, getObject, parseCommit, parseTree, putObject, buildTreeFromFlat, flattenTreeOfCommit,
  makeCommit, listCommits, isAncestor, diffTrees, lineDiff,
  repoGlobalId, issueGlobalId, pullGlobalId,
} from './store.ts';

export interface RestResponse {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

const json = (status: number, value: unknown, headers?: Record<string, string>): RestResponse => ({
  status, contentType: 'application/json', body: JSON.stringify(value), headers,
});
const err = (status: number, message: string): RestResponse => json(status, { message });
const notFound = (): RestResponse => err(404, 'Not Found');

export function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.id, node_id: repoGlobalId(repo), name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User', avatar_url: '' },
    private: repo.private, description: repo.description,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt, updated_at: repo.updatedAt, pushed_at: repo.updatedAt,
    has_issues: true, has_projects: true, has_wiki: true, has_pages: false, has_downloads: true,
    forks_count: 0, stargazers_count: 0, watchers_count: 0, open_issues_count: openIssues,
    license: null, topics: [], visibility: repo.private ? 'private' : 'public',
    archived: false, disabled: false, fork: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: issueGlobalId(repo, issue), number: issue.number,
    title: issue.title, body: issue.body, state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => {
      const def = repo.labels.find((l) => l.name === name);
      return { name, color: def?.color ?? '000000', description: def?.description ?? '' };
    }),
    created_at: issue.createdAt, updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    comments_url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    locked: false, assignee: null, assignees: [], milestone: null,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id, node_id: pullGlobalId(repo, pull), number: pull.number,
    title: pull.title, body: pull.body, state: pull.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeSha,
    mergeable: mergeable(repo, pull),
    created_at: pull.createdAt, updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false, locked: false, assignee: null, assignees: [], milestone: null,
    requested_reviewers: [], requested_teams: [],
  };
}

/** Whether the PR can merge cleanly onto its base branch's current tip. */
export function mergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return false;
  if (baseTip === pull.baseSha) return true;
  const headChanges = new Set(diffTrees(repo, treeOfCommit(repo, pull.baseSha), treeOfCommit(repo, pull.headSha)).map((d) => d.path));
  const baseChanges = new Set(diffTrees(repo, treeOfCommit(repo, pull.baseSha), treeOfCommit(repo, baseTip)).map((d) => d.path));
  for (const p of headChanges) if (baseChanges.has(p)) return false;
  return true;
}

export function treeOfCommit(repo: Repo, sha: string): string {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== 'commit') return '';
  return parseCommit(obj.data).tree;
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Create or update a file on a branch; creates the branch from the default tip when missing. */
export function commitFile(
  repo: Repo, branch: string, path: string, content: Buffer, message: string,
): { commitSha: string; blobSha: string; created: boolean } {
  let tip = branchTip(repo, branch);
  if (tip === null) {
    // New branch from the default branch tip (or unborn).
    tip = branchTip(repo, repo.defaultBranch);
    if (tip !== null) repo.refs.set(`refs/heads/${branch}`, tip);
  }
  const flat = tip ? flattenTreeOfCommit(repo, tip) : new Map<string, { mode: string; sha: string }>();
  const created = !flat.has(path);
  const blobSha = putObject(repo, 'blob', content);
  flat.set(path, { mode: '100644', sha: blobSha });
  const treeSha = buildTreeFromFlat(repo, flat);
  const parents = tip ? [tip] : [];
  const commitSha = makeCommit(repo, treeSha, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha, created };
}

/** Create an issue record (shared by REST, GraphQL and MCP). */
export function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): { issue: Issue } | { error: string } {
  if (title === '') return { error: 'Validation Failed.' };
  for (const l of labels) if (!repo.labels.some((x) => x.name === l)) return { error: `Validation Failed: label "${l}" does not exist.` };
  const { iso } = tick();
  repo.issueCounter += 1;
  const issue: Issue = {
    id: repo.id * 100000 + repo.issueCounter, number: repo.issueCounter,
    title, body, state: 'open', labels, createdSeq: nextSeq(), updatedSeq: nextSeq(),
    createdAt: iso, updatedAt: iso, comments: [],
  };
  repo.issues.push(issue);
  return { issue };
}

/** Create a pull request record (shared by REST, GraphQL and MCP). */
export function createPullRecord(repo: Repo, title: string, body: string, headRef: string, baseRef: string): { pull: Pull } | { error: string } {
  if (title === '' || headRef === '') return { error: 'Validation Failed.' };
  const headSha = branchTip(repo, headRef);
  const baseSha = branchTip(repo, baseRef);
  if (headSha === null || baseSha === null) return { error: 'Validation Failed: head or base branch not found.' };
  if (repo.pulls.some((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef)) {
    return { error: 'Validation Failed: a pull request already exists for this head branch.' };
  }
  const { iso } = tick();
  repo.pullCounter += 1;
  const pull: Pull = {
    id: repo.id * 100000 + repo.pullCounter, number: repo.pullCounter,
    title, body, state: 'open', headRef, baseRef, headSha, baseSha,
    merged: false, mergedAt: null, mergeSha: null,
    createdSeq: nextSeq(), updatedSeq: nextSeq(), createdAt: iso, updatedAt: iso,
  };
  repo.pulls.push(pull);
  return { pull };
}

/** Squash-merge an open, mergeable pull request onto its base branch. Null when it cannot merge. */
export function doMerge(repo: Repo, pull: Pull): { sha: string; message: string } | null {
  if (pull.state !== 'open' || pull.merged) return null;
  if (!mergeable(repo, pull)) return null;
  const baseTip = branchTip(repo, pull.baseRef)!;
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
  pull.updatedSeq = nextSeq();
  return { sha: mergeSha, message: pull.title };
}

function paginate<T>(items: T[], query: URLSearchParams, basePath: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  const links: string[] = [];
  const urlFor = (p: number): string => `${basePath}${basePath.includes('?') ? '&' : '?'}per_page=${perPage}&page=${p}`;
  if (start + perPage < items.length) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  if (links.length > 0) link = links.join(', ');
  return { page: slice, link };
}

export interface RestRequest {
  method: string;
  segments: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: unknown; // parsed JSON, or undefined when no body
  bodyParseError: boolean;
  host: string; // for absolute Link URLs
}

export function handleRest(store: Store, req: RestRequest): RestResponse {
  const { method, segments: s, query } = req;
  if (req.bodyParseError) return err(400, 'Problems parsing JSON');

  // ---- API root and meta
  if (s.length === 0) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
    }, { 'X-OAuth-Scopes': 'repo, read:org', 'X-Accepted-OAuth-Scopes': 'repo, read:org' });
  }
  if (s[0] === 'meta' && s.length === 1) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // ---- /user
  if (s[0] === 'user' && s.length === 1) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, {
      login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User',
      name: 'Ada Iversen', email: VIEWER_EMAIL,
      html_url: `https://github.com/${VIEWER_LOGIN}`,
      avatar_url: '', created_at: '2026-11-14T00:00:00Z', updated_at: '2026-11-14T00:00:00Z',
    });
  }

  // ---- /user/repos
  if (s[0] === 'user' && s[1] === 'repos' && s.length === 2) {
    if (method === 'GET') {
      const repos = store.listRepos().filter((r) => r.owner === VIEWER_LOGIN);
      const base = `http://${req.host}/api/v3/user/repos`;
      const { page, link } = paginate(repos.map(repoJson), query, base);
      return json(200, page, link ? { Link: link } : undefined);
    }
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || /[^\w.-]/.test(name)) return err(422, 'Repository creation failed.');
      const repo = store.createRepo(name, { private: body.private === true, description: typeof body.description === 'string' ? body.description : '' });
      if (repo === null) return err(422, 'Repository already exists.');
      return json(201, repoJson(repo));
    }
    return err(405, 'Method Not Allowed');
  }

  // ---- /repos/{owner}/{repo}/...
  if (s[0] === 'repos' && s.length >= 3) {
    const owner = decodeURIComponent(s[1]!);
    const name = decodeURIComponent(s[2]!);
    const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, name) : null;
    if (repo === null) return notFound();
    const rest = s.slice(3);
    return handleRepo(store, repo, rest, req);
  }

  return notFound();
}

function handleRepo(store: Store, repo: Repo, rest: string[], req: RestRequest): RestResponse {
  const { method, query } = req;

  // ---- repo itself
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) repo.defaultBranch = body.default_branch;
      repo.updatedAt = tick().iso;
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, contentType: 'application/json', body: '' };
    }
    return err(405, 'Method Not Allowed');
  }

  // ---- branches
  if (rest[0] === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      const list = [...repo.refs.entries()]
        .filter(([n]) => n.startsWith('refs/heads/'))
        .map(([n, sha]) => ({ name: n.slice(11), commit: { sha, url: '' }, protected: false }));
      return json(200, list);
    }
    if (rest.length === 2) {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      const branch = decodeURIComponent(rest[1]!);
      const tip = branchTip(repo, branch);
      if (tip === null) return notFound();
      return json(200, { name: branch, commit: { sha: tip, url: '' }, protected: false });
    }
    return notFound();
  }

  // ---- commits
  if (rest[0] === 'commits') {
    if (rest.length === 1) {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      const shaParam = query.get('sha');
      const tip = shaParam ? (branchTip(repo, shaParam) ?? (getObject(repo, shaParam)?.type === 'commit' ? shaParam : null)) : branchTip(repo, repo.defaultBranch);
      if (tip === null) return json(200, []);
      const shas = listCommits(repo, tip, 100);
      const out = shas.map((sha) => {
        const info = parseCommit(getObject(repo, sha)!.data);
        return {
          sha, commit: { message: info.message, author: { name: 'Ada Iversen', email: VIEWER_EMAIL, date: new Date(info.authorUnix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') } },
          parents: info.parents.map((p) => ({ sha: p })),
        };
      });
      return json(200, out);
    }
    if (rest.length === 2) {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      const sha = decodeURIComponent(rest[1]!);
      const obj = getObject(repo, sha);
      if (!obj || obj.type !== 'commit') return notFound();
      const info = parseCommit(obj.data);
      return json(200, {
        sha, commit: { message: info.message, author: { name: 'Ada Iversen', email: VIEWER_EMAIL, date: new Date(info.authorUnix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') } },
        parents: info.parents.map((p) => ({ sha: p })),
      });
    }
    return notFound();
  }

  // ---- git data: refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !getObject(repo, sha)) return err(422, 'Invalid ref or sha.');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists.');
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: 'commit', url: '' } });
    }
    if (method === 'GET') {
      const refPath = rest.slice(2).map(decodeURIComponent).join('/');
      if (refPath === '') {
        const list = [...repo.refs.entries()].map(([n, sha]) => ({ ref: n, object: { sha, type: 'commit', url: '' } }));
        return json(200, list);
      }
      const sha = repo.refs.get(`refs/${refPath}`) ?? repo.refs.get(refPath);
      if (!sha) return notFound();
      const full = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
      return json(200, { ref: full, object: { sha, type: 'commit', url: '' } });
    }
    return err(405, 'Method Not Allowed');
  }

  // ---- contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map(decodeURIComponent).join('/');
    return handleContents(repo, path, req);
  }

  // ---- labels
  if (rest[0] === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') return json(200, repo.labels);
      if (method === 'POST') {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return err(422, 'Validation Failed.');
        const existing = repo.labels.find((l) => l.name === name);
        if (existing) return json(201, existing); // idempotent: re-creating a label returns it
        const label = { name, color: typeof body.color === 'string' ? body.color : '000000', description: typeof body.description === 'string' ? body.description : '' };
        repo.labels.push(label);
        return json(201, label);
      }
      return err(405, 'Method Not Allowed');
    }
    return notFound();
  }

  // ---- issues
  if (rest[0] === 'issues') {
    return handleIssues(repo, rest.slice(1), req);
  }

  // ---- pulls
  if (rest[0] === 'pulls') {
    return handlePulls(repo, rest.slice(1), req);
  }

  return notFound();
}

function handleContents(repo: Repo, path: string, req: RestRequest): RestResponse {
  const { method, query } = req;
  const refParam = query.get('ref');
  const tip = refParam
    ? (branchTip(repo, refParam) ?? (getObject(repo, refParam)?.type === 'commit' ? refParam : null))
    : branchTip(repo, repo.defaultBranch);

  if (method === 'GET') {
    if (tip === null) return notFound();
    const flat = flattenTreeOfCommit(repo, tip);
    if (path === '') {
      // root directory listing
      const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
      for (const [p, v] of flat) {
        const first = p.split('/')[0]!;
        if (p.includes('/')) {
          if (!entries.has(first)) {
            const dirTree = dirTreeSha(repo, tip, first);
            entries.set(first, { type: 'dir', name: first, path: first, sha: dirTree });
          }
        } else {
          entries.set(first, { type: 'file', name: first, path: first, sha: v.sha });
        }
      }
      return json(200, [...entries.values()]);
    }
    const entry = flat.get(path);
    if (entry) {
      const obj = getObject(repo, entry.sha)!;
      return json(200, {
        type: 'file', encoding: 'base64', size: obj.data.length, name: path.split('/').pop(),
        path, content: obj.data.toString('base64'), sha: entry.sha,
      });
    }
    // directory?
    const prefix = path + '/';
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [p, v] of flat) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const first = rest.split('/')[0]!;
      if (rest.includes('/')) {
        if (!children.has(first)) {
          children.set(first, { type: 'dir', name: first, path: `${path}/${first}`, sha: dirTreeSha(repo, tip, `${path}/${first}`) });
        }
      } else {
        children.set(first, { type: 'file', name: first, path: p, sha: v.sha });
      }
    }
    if (children.size > 0) return json(200, [...children.values()]);
    return notFound();
  }

  if (method === 'PUT') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const shaParam = typeof body.sha === 'string' ? body.sha : null;
    const targetBranch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    if (contentB64 === '') return err(422, 'Validation Failed.');
    const content = Buffer.from(contentB64, 'base64');
    const currentTip = branchTip(repo, targetBranch) ?? branchTip(repo, repo.defaultBranch);
    const flat = currentTip ? flattenTreeOfCommit(repo, currentTip) : new Map();
    const existing = flat.get(path);
    if (shaParam !== null) {
      if (!existing || existing.sha !== shaParam) return err(409, 'Conflict: sha does not match.');
    }
    const { commitSha, blobSha, created } = commitFile(repo, targetBranch, path, content, message);
    return json(created ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
  }

  if (method === 'DELETE') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const shaParam = typeof body.sha === 'string' ? body.sha : '';
    const targetBranch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const currentTip = branchTip(repo, targetBranch);
    if (currentTip === null) return notFound();
    const flat = flattenTreeOfCommit(repo, currentTip);
    const existing = flat.get(path);
    if (!existing) return notFound();
    if (shaParam !== '' && existing.sha !== shaParam) return err(422, 'Validation Failed.');
    flat.delete(path);
    const treeSha = buildTreeFromFlat(repo, flat);
    const commitSha = makeCommit(repo, treeSha, [currentTip], message);
    repo.refs.set(`refs/heads/${targetBranch}`, commitSha);
    return json(200, { commit: { sha: commitSha, message } });
  }

  return err(405, 'Method Not Allowed');
}

function dirTreeSha(repo: Repo, tip: string, dirPath: string): string {
  const obj = getObject(repo, tip);
  if (!obj || obj.type !== 'commit') return ZERO_OID;
  let treeSha = parseCommit(obj.data).tree;
  for (const part of dirPath.split('/')) {
    const tree = getObject(repo, treeSha);
    if (!tree || tree.type !== 'tree') return ZERO_OID;
    const entries = parseTree(tree.data);
    const found = entries.find((e) => e.name === part && e.mode === '40000');
    if (!found) return ZERO_OID;
    treeSha = found.sha;
  }
  return treeSha;
}

function handleIssues(repo: Repo, rest: string[], req: RestRequest): RestResponse {
  const { method, query } = req;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      list = [...list].sort((a, b) => {
        const d = sort === 'created' ? a.createdSeq - b.createdSeq : a.number - b.number;
        return direction === 'asc' ? d : -d;
      });
      const base = `http://${req.host}/api/v3/repos/${repo.owner}/${repo.name}/issues`;
      const { page, link } = paginate(list.map((i) => issueJson(repo, i)), query, base);
      return json(200, page, link ? { Link: link } : undefined);
    }
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      const result = createIssueRecord(repo, title, typeof body.body === 'string' ? body.body : '', labels);
      if ('error' in result) return err(422, result.error);
      return json(201, issueJson(repo, result.issue));
    }
    return err(405, 'Method Not Allowed');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return json(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const l of labels) if (!repo.labels.some((x) => x.name === l)) return err(422, `Validation Failed: label "${l}" does not exist.`);
        issue.labels = labels;
      }
      const { iso } = tick();
      issue.updatedAt = iso;
      issue.updatedSeq = nextSeq();
      return json(200, issueJson(repo, issue));
    }
    return err(405, 'Method Not Allowed');
  }

  if (rest[0] && rest[1] === 'comments') {
    if (method === 'GET') {
      return json(200, issue.comments.map((c) => ({
        id: c.id, body: c.body, created_at: c.createdAt, updated_at: c.createdAt,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
        url: `/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
      })));
    }
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return err(422, 'Validation Failed.');
      const { iso } = tick();
      repo.commentCounter += 1;
      const comment = { id: repo.id * 1000000 + repo.commentCounter, body: text, createdSeq: nextSeq(), createdAt: iso };
      issue.comments.push(comment);
      return json(201, {
        id: comment.id, body: comment.body, created_at: comment.createdAt, updated_at: comment.createdAt,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
        url: `/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
      });
    }
    return err(405, 'Method Not Allowed');
  }

  return notFound();
}

function handlePulls(repo: Repo, rest: string[], req: RestRequest): RestResponse {
  const { method, query } = req;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      list = [...list].sort((a, b) => b.number - a.number);
      const base = `http://${req.host}/api/v3/repos/${repo.owner}/${repo.name}/pulls`;
      const { page, link } = paginate(list.map((p) => pullJson(repo, p)), query, base);
      return json(200, page, link ? { Link: link } : undefined);
    }
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      const headRaw = typeof body.head === 'string' ? body.head : '';
      const baseRaw = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      const headRef = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
      const baseRef = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
      const result = createPullRecord(repo, title, typeof body.body === 'string' ? body.body : '', headRef, baseRef);
      if ('error' in result) return err(422, result.error);
      return json(201, pullJson(repo, result.pull));
    }
    return err(405, 'Method Not Allowed');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return json(200, pullJson(repo, pull));
    if (method === 'PATCH') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (typeof body.state === 'string' && body.state === 'closed' && pull.state === 'open') pull.state = 'closed';
      const { iso } = tick();
      pull.updatedAt = iso;
      pull.updatedSeq = nextSeq();
      return json(200, pullJson(repo, pull));
    }
    return err(405, 'Method Not Allowed');
  }

  if (rest[1] === 'files' && rest.length === 2) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    const diffs = diffTrees(repo, treeOfCommit(repo, pull.baseSha), treeOfCommit(repo, pull.headSha));
    const out = diffs.map((d) => {
      let additions = 0, deletions = 0;
      if (d.status === 'added' && d.newSha) {
        const text = getObject(repo, d.newSha)?.data.toString('utf8') ?? '';
        additions = text === '' ? 0 : text.split('\n').length;
      } else if (d.status === 'modified' && d.oldSha && d.newSha) {
        const oldText = getObject(repo, d.oldSha)?.data.toString('utf8') ?? '';
        const newText = getObject(repo, d.newSha)?.data.toString('utf8') ?? '';
        const r = lineDiff(oldText, newText);
        additions = r.additions; deletions = r.deletions;
      } else if (d.status === 'removed' && d.oldSha) {
        const text = getObject(repo, d.oldSha)?.data.toString('utf8') ?? '';
        deletions = text === '' ? 0 : text.split('\n').length;
      }
      return {
        filename: d.path, status: d.status === 'added' ? 'added' : d.status === 'modified' ? 'modified' : 'removed',
        additions, deletions, changes: additions + deletions,
        sha: d.newSha ?? d.oldSha, raw_url: '', blob_url: '', patch: '',
      };
    });
    return json(200, out);
  }

  if (rest[1] === 'merge' && rest.length === 2) {
    if (method !== 'PUT') return err(405, 'Method Not Allowed');
    if (pull.state !== 'open' || pull.merged) return err(405, 'Pull request is already merged or closed.');
    if (!mergeable(repo, pull)) return err(405, 'Pull request is not mergeable.');
    const merged = doMerge(repo, pull);
    if (merged === null) return err(405, 'Pull request is not mergeable.');
    return json(200, { merged: true, sha: merged.sha, message: merged.message });
  }

  return notFound();
}
