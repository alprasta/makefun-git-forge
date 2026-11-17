// store.ts — the forge's in-memory store: git object model, pack codec, and the
// REST/GraphQL/MCP resource records. One process, no clock: every timestamp comes
// from a logical counter so two runs on the same operations leave identical state.
import { createHash } from 'node:crypto';
import { createInflate, deflateSync, inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** Logical clock: deterministic timestamps. Base = competition open, one second per tick. */
const BASE_EPOCH_S = Date.UTC(2026, 10, 14, 0, 0, 0) / 1000;
let clockTick = 0;
export function tick(): { unix: number; iso: string } {
  clockTick += 1;
  const unix = BASE_EPOCH_S + clockTick;
  return { unix, iso: new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}
/** Monotonic sequence for ordering records (issues, comments, pulls) across surfaces. */
export function nextSeq(): number {
  clockTick += 1;
  return clockTick;
}

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
export function isOid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

// ---------------------------------------------------------------- git objects

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer }

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([header, data]));
}

export interface TreeEntry { mode: string; name: string; sha: string }
export interface CommitInfo { tree: string; parents: string[]; message: string; authorUnix: number; seq: number }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const lines = head.split('\n');
  let tree = '';
  const parents: string[] = [];
  let authorUnix = BASE_EPOCH_S;
  let seq = 0;
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = line.match(/ (\d+) [+-]\d{4}$/);
      if (m) authorUnix = Number(m[1]);
    }
  }
  const message = text.slice(head.length + 2);
  return { tree, parents, message, authorUnix, seq };
}

// ---------------------------------------------------------------- resources

export interface Label { name: string; color: string; description: string }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; createdSeq: number; updatedSeq: number; createdAt: string; updatedAt: string;
  comments: Comment[];
}
export interface Comment { id: number; body: string; createdSeq: number; createdAt: string }
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeSha: string | null;
  createdSeq: number; updatedSeq: number; createdAt: string; updatedAt: string;
}
export interface Repo {
  id: number; name: string; owner: string; private: boolean; description: string;
  defaultBranch: string; createdSeq: number; createdAt: string; updatedAt: string;
  objects: Map<string, GitObject>;
  commitSeq: Map<string, number>;
  refs: Map<string, string>;
  issues: Issue[]; issueCounter: number; commentCounter: number;
  pulls: Pull[]; pullCounter: number;
  labels: Label[];
}

const DEFAULT_LABELS: Label[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

export class Store {
  repos = new Map<string, Repo>(); // key: owner + '/' + name
  repoCounter = 0;
  reqCounter = 0;

  key(owner: string, name: string): string { return `${owner}/${name}`; }

  createRepo(name: string, opts: { private?: boolean; description?: string }): Repo | null {
    const key = this.key(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return null;
    this.repoCounter += 1;
    const { iso } = tick();
    const repo: Repo = {
      id: this.repoCounter, name, owner: VIEWER_LOGIN,
      private: opts.private ?? false, description: opts.description ?? '',
      defaultBranch: DEFAULT_BRANCH, createdSeq: clockTick, createdAt: iso, updatedAt: iso,
      objects: new Map(), commitSeq: new Map(), refs: new Map(),
      issues: [], issueCounter: 0, commentCounter: 0,
      pulls: [], pullCounter: 0,
      labels: DEFAULT_LABELS.map((l) => ({ ...l })),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  nextRequestId(): string {
    this.reqCounter += 1;
    return `req-${this.reqCounter}`;
  }
}

// ---------------------------------------------------------------- object store helpers

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function getObject(repo: Repo, sha: string): GitObject | null {
  return repo.objects.get(sha) ?? null;
}

/** Flat path -> {mode, sha} for the tree at a commit. */
export function flattenTree(repo: Repo, treeSha: string, prefix = ''): Map<string, { mode: string; sha: string }> {
  const out = new Map<string, { mode: string; sha: string }>();
  const obj = getObject(repo, treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [p, v] of flattenTree(repo, e.sha, path)) out.set(p, v);
    } else {
      out.set(path, { mode: e.mode, sha: e.sha });
    }
  }
  return out;
}

/** Build (nested) tree objects from a flat path map; returns the root tree sha. */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; sha: string }>): string {
  interface Node { files: Map<string, { mode: string; sha: string }>; dirs: Map<string, Node> }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, v] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (!next) { next = { files: new Map(), dirs: new Map() }; node.dirs.set(part, next); }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, v);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of node.files) entries.push({ mode: v.mode, name, sha: v.sha });
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, sha: build(sub) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

export function makeCommit(repo: Repo, treeSha: string, parents: string[], message: string): string {
  const { unix } = tick();
  const who = `Ada Iversen <${VIEWER_EMAIL}> ${unix} +0000`;
  let text = `tree ${treeSha}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${who}\ncommitter ${who}\n\n${message}`;
  const sha = putObject(repo, 'commit', Buffer.from(text, 'utf8'));
  repo.commitSeq.set(sha, clockTick);
  return sha;
}

/** Flat path map for a commit's tree. */
export function flattenTreeOfCommit(repo: Repo, commitSha: string): Map<string, { mode: string; sha: string }> {
  const obj = getObject(repo, commitSha);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(obj.data).tree);
}

/** Record a commit that arrived from outside (push) for newest-first ordering. */
export function noteCommit(repo: Repo, sha: string): void {
  if (!repo.commitSeq.has(sha)) repo.commitSeq.set(sha, clockTick);
}

/** Commit shas reachable from tip, newest first (by logical seq). */
export function listCommits(repo: Repo, tipSha: string, limit = 100): string[] {
  const seen = new Set<string>();
  const stack: string[] = [tipSha];
  const found: string[] = [];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = getObject(repo, sha);
    if (!obj || obj.type !== 'commit') continue;
    found.push(sha);
    const info = parseCommit(obj.data);
    for (const p of info.parents) stack.push(p);
  }
  found.sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
  return found.slice(0, limit);
}

export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === anc) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = getObject(repo, sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** Paths changed between two trees: path -> {status, oldSha, newSha}. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldSha: string | null; newSha: string | null }> {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldSha: string | null; newSha: string | null }> = [];
  for (const [path, v] of head) {
    const b = base.get(path);
    if (!b) out.push({ path, status: 'added', oldSha: null, newSha: v.sha });
    else if (b.sha !== v.sha) out.push({ path, status: 'modified', oldSha: b.sha, newSha: v.sha });
  }
  for (const [path, v] of base) {
    if (!head.has(path)) out.push({ path, status: 'removed', oldSha: v.sha, newSha: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

/** Line diff counts for one file (LCS on lines, small files only; fallback prefix/suffix). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length * b.length > 250000) {
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
    return { additions: b.length - pre - suf, deletions: a.length - pre - suf };
  }
  // LCS dynamic programming
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  return { additions: n - dp[0]![0]!, deletions: m - dp[0]![0]! };
}

// ---------------------------------------------------------------- pack codec

interface PackEntry { type: ObjType; data: Buffer }

function readVarint(buf: Buffer, off: number): { value: number; type: number; next: number } {
  let byte = buf[off]!;
  const type = (byte >> 4) & 7;
  let value = byte & 0x0f;
  let shift = 4;
  let i = off + 1;
  while (byte & 0x80) {
    byte = buf[i]!;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { value, type, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVar = (): number => {
    let v = 0; let shift = 0;
    for (;;) {
      const b = delta[off]!;
      off += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVar();
  const tgtSize = readVar();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let outLen = 0;
  while (off < delta.length) {
    const op = delta[off]!;
    off += 1;
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOff |= delta[off]! << (8 * i); off += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= delta[off]! << (8 * i); off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      outLen += cpSize;
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      outLen += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== tgtSize || outLen !== tgtSize) throw new Error('delta target size mismatch');
  return out;
}

/** Inflate the zlib stream starting at `off`, reporting the exact number of
 *  compressed bytes it consumed. Node's streaming Inflate exposes that as
 *  `bytesWritten` once the stream ends (verified on Node 22/24, including
 *  concatenated streams with trailing garbage): one inflate instead of the
 *  ~log2 binary search `inflatedLength` used to do. */
function inflateExact(buf: Buffer, off: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inf = createInflate();
    const chunks: Buffer[] = [];
    inf.on('data', (c) => chunks.push(c as Buffer));
    inf.on('error', reject);
    inf.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: inf.bytesWritten }));
    inf.end(buf.subarray(off));
  });
}

/** Decode a packfile into objects. `lookup` resolves REF_DELTA bases the pack does not carry. */
export async function decodePack(pack: Buffer, lookup: (sha: string) => GitObject | null): Promise<Map<string, GitObject>> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const byOffset = new Map<number, GitObject>();
  const objects = new Map<string, GitObject>();
  let off = 12;
  const typeOf = (n: number): ObjType => (n === 1 ? 'commit' : n === 2 ? 'tree' : n === 3 ? 'blob' : n === 4 ? 'tag' : (() => { throw new Error(`bad object type ${n}`); })());
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const { value: size, type, next } = readVarint(pack, off);
    off = next;
    let obj: GitObject;
    const readZlib = async (): Promise<Buffer> => {
      // Fast path: one streaming inflate with the exact consumed length.
      try {
        const { data, consumed } = await inflateExact(pack, off);
        if (consumed > 0) { off += consumed; return data; }
      } catch { /* fall through to the binary-search length probe */ }
      const len = inflatedLength(pack, off);
      const data = inflateSync(pack.subarray(off, off + len));
      off += len;
      return data;
    };
    if (type === 6) {
      // OFS_DELTA: offset encoded backwards
      let byte = pack[off]!; off += 1;
      let deltaOff = byte & 0x7f;
      while (byte & 0x80) { byte = pack[off]!; off += 1; deltaOff = ((deltaOff + 1) << 7) | (byte & 0x7f); }
      const baseOff = start - deltaOff;
      const base = byOffset.get(baseOff);
      if (!base) throw new Error('ofs-delta base not found');
      const delta = await readZlib();
      const data = applyDelta(base.data, delta);
      obj = { type: base.type, data };
    } else if (type === 7) {
      const baseSha = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const delta = await readZlib();
      const baseObj = objects.get(baseSha) ?? lookup(baseSha);
      if (!baseObj) throw new Error('ref-delta base not found');
      const data = applyDelta(baseObj.data, delta);
      obj = { type: baseObj.type, data };
    } else {
      const data = await readZlib();
      obj = { type: typeOf(type), data };
    }
    const sha = hashObject(obj.type, obj.data);
    byOffset.set(start, obj);
    objects.set(sha, obj);
  }
  return objects;
}

/** How many bytes the zlib stream starting at `off` occupies. Node's inflateSync
 *  ignores trailing bytes, so "this slice inflates" is monotone in slice length:
 *  binary-search the smallest slice that inflates. */
function inflatedLength(pack: Buffer, off: number): number {
  let lo = 1, hi = pack.length - off;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try { inflateSync(pack.subarray(off, off + mid)); hi = mid; } catch { lo = mid + 1; }
  }
  inflateSync(pack.subarray(off, off + lo)); // throws when the stream is corrupt
  return lo;
}

export function encodePack(entries: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const e of entries) {
    const typeNum = e.type === 'commit' ? 1 : e.type === 'tree' ? 2 : e.type === 'blob' ? 3 : 4;
    const comp = deflateSync(e.data);
    // varint: low 4 bits of size + type, then 7-bit groups
    const size = e.data.length;
    const bytes: number[] = [];
    let s = size;
    let first = (typeNum << 4) | (s & 0x0f);
    s >>= 4;
    if (s > 0) first |= 0x80;
    bytes.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>= 7;
      if (s > 0) b |= 0x80;
      bytes.push(b);
    }
    parts.push(Buffer.from(bytes));
    parts.push(comp);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The target oid a tag object points at (`object <sha>` header), or null. */
export function parseTagTarget(data: Buffer): string | null {
  const m = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return m ? m[1]! : null;
}

/** All objects reachable from a commit (commit + trees + blobs), in a stable order. */
export function closureObjects(repo: Repo, tips: string[], exclude: Set<string>): GitObject[] {
  const out: GitObject[] = [];
  const seen = new Set<string>(exclude);
  const queue: string[] = [...tips];
  const commits: string[] = [];
  while (queue.length > 0) {
    const sha = queue.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = getObject(repo, sha);
    if (!obj) continue;
    if (obj.type === 'commit') {
      commits.push(sha);
      const info = parseCommit(obj.data);
      queue.push(info.tree);
      for (const p of info.parents) queue.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push(e.sha);
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) queue.push(target);
    }
  }
  // Emit commits first (newest first), then trees, then blobs, then tags — deterministic.
  const byType = (t: ObjType): GitObject[] => {
    const list: GitObject[] = [];
    for (const sha of seen) {
      if (exclude.has(sha)) continue;
      const o = getObject(repo, sha);
      if (o && o.type === t) list.push(o);
    }
    return list;
  };
  const commitObjs = byType('commit').sort((a, b) => {
    const sa = hashObject('commit', a.data); const sb = hashObject('commit', b.data);
    return (repo.commitSeq.get(sb) ?? 0) - (repo.commitSeq.get(sa) ?? 0);
  });
  out.push(...commitObjs, ...byType('tree'), ...byType('blob'), ...byType('tag'));
  void commits;
  return out;
}

/** Shallow-aware closure: commits within `depth` generations of tips + their trees/blobs.
 *  The shallow boundary is the deepest SENT commits: an included commit whose
 *  parent is not included (for depth 1 that is the tip itself). */
export function shallowClosure(repo: Repo, tips: string[], depth: number): { objects: GitObject[]; shallow: string[] } {
  const genOf = new Map<string, number>();
  const queue: Array<[string, number]> = tips.map((t) => [t, 0] as [string, number]);
  while (queue.length > 0) {
    const [sha, gen] = queue.shift()!;
    const prev = genOf.get(sha);
    if (prev !== undefined && prev <= gen) continue;
    genOf.set(sha, gen);
    if (gen >= depth) continue; // past the depth limit: not sent, not expanded
    const obj = getObject(repo, sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push([p, gen + 1]);
  }
  const included = new Set<string>();
  for (const [sha, gen] of genOf) if (gen < depth) included.add(sha);
  // Boundary: an included commit with no included parent (a root commit at the
  // boundary counts too: git lists it as shallow, e.g. --depth 2 on a 2-commit repo).
  const boundary = new Set<string>();
  for (const sha of included) {
    const obj = getObject(repo, sha);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (!parents.some((p) => included.has(p))) boundary.add(sha);
  }
  const objects: GitObject[] = [];
  const seen = new Set<string>();
  const collect = (sha: string): void => {
    if (seen.has(sha)) return;
    seen.add(sha);
    const obj = getObject(repo, sha);
    if (!obj) return;
    objects.push(obj);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      collect(info.tree);
      if (included.has(sha)) {
        for (const p of info.parents) if (included.has(p)) collect(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) collect(e.sha);
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) collect(target);
    }
  };
  for (const sha of included) collect(sha);
  // Order: commits newest first, then trees, then blobs, then tags.
  const order = (o: GitObject): number => (o.type === 'commit' ? 0 : o.type === 'tree' ? 1 : o.type === 'blob' ? 2 : 3);
  objects.sort((a, b) => {
    const oa = order(a), ob = order(b);
    if (oa !== ob) return oa - ob;
    if (oa === 0) {
      const sa = hashObject('commit', a.data); const sb = hashObject('commit', b.data);
      return (repo.commitSeq.get(sb) ?? 0) - (repo.commitSeq.get(sa) ?? 0);
    }
    return 0;
  });
  return { objects, shallow: [...boundary] };
}

// ---------------------------------------------------------------- global ids (opaque, stable)

function b64(s: string): string { return Buffer.from(s, 'utf8').toString('base64'); }
function unb64(s: string): string | null {
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return null; }
}
export function repoGlobalId(repo: Repo): string { return b64(`Repository:${repo.id}`); }
export function issueGlobalId(repo: Repo, issue: Issue): string { return b64(`Issue:${repo.id}:${issue.number}`); }
export function pullGlobalId(repo: Repo, pull: Pull): string { return b64(`PullRequest:${repo.id}:${pull.number}`); }
export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string { return b64(`IssueComment:${repo.id}:${issue.number}:${comment.id}`); }
export function parseGlobalId(id: string): { kind: string; repoId: number; number?: number; commentId?: number } | null {
  const raw = unb64(id);
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts[0] === 'Repository' && parts.length === 2) return { kind: 'Repository', repoId: Number(parts[1]) };
  if (parts[0] === 'Issue' && parts.length === 3) return { kind: 'Issue', repoId: Number(parts[1]), number: Number(parts[2]) };
  if (parts[0] === 'PullRequest' && parts.length === 3) return { kind: 'PullRequest', repoId: Number(parts[1]), number: Number(parts[2]) };
  if (parts[0] === 'IssueComment' && parts.length === 4) return { kind: 'IssueComment', repoId: Number(parts[1]), number: Number(parts[2]), commentId: Number(parts[3]) };
  return null;
}
export function cursorFor(n: number): string { return b64(`cursor:${n}`); }
export function cursorToNumber(c: string): number | null {
  const raw = unb64(c);
  if (!raw || !raw.startsWith('cursor:')) return null;
  const n = Number(raw.slice(7));
  return Number.isInteger(n) ? n : null;
}
