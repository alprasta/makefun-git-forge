// git.ts — git smart HTTP: info/refs advertisements, protocol v2 upload-pack
// (ls-refs, fetch incl. shallow), and v0 receive-pack with report-status.
import { Buffer } from 'node:buffer';
import {
  ZERO_OID, DEFAULT_BRANCH, VIEWER_LOGIN,
  type Repo, type Store,
  getObject, parseCommit, parseTree, parseTagTarget, isAncestor, flattenTreeOfCommit, noteCommit,
  decodePack, encodePack, closureObjects, shallowClosure, hashObject,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export interface Pkt { kind: 'data' | 'flush' | 'delim'; payload: Buffer }
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** Parse a v2 command request: returns {command, args, caps}. */
export function parseV2Request(buf: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(buf);
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
    if (p.kind === 'delim') break;
  }
  const args: string[] = [];
  let command = '';
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') { afterDelim = true; continue; }
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice(8).trim();
    } else {
      args.push(line.replace(/\n$/, ''));
    }
  }
  void lines;
  return { command, args };
}

// ---------------------------------------------------------------- advertisements

function headRef(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

export function uploadPackAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=git-upload-pack\n'));
  parts.push(pktFlush());
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine('agent=makefun-git-forge/1.0.0\n'));
  parts.push(pktLine('ls-refs=unborn\n'));
  parts.push(pktLine('fetch=shallow wait-for-done\n'));
  parts.push(pktLine('server-option\n'));
  parts.push(pktLine('object-format=sha1\n'));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function receivePackAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=git-receive-pack\n'));
  parts.push(pktFlush());
  const head = headRef(repo);
  const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=makefun-git-forge/1.0.0';
  parts.push(pktLine(`${head} HEAD\0${caps}\n`));
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, sha] of refs) parts.push(pktLine(`${sha} ${name}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs

export function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false, symrefs = false, unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice(11));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  // Peel a tag (possibly nested) to the commit it ultimately points at.
  const peelToCommit = (sha: string): string | null => {
    let cur = sha;
    for (let i = 0; i < 8; i += 1) {
      const obj = getObject(repo, cur);
      if (!obj) return null;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (!target) return null;
        cur = target;
        continue;
      }
      return null;
    }
    return null;
  };
  const parts: Buffer[] = [];
  const pushRef = (oid: string, name: string, extra = ''): void => {
    if (!keep(name)) return;
    let suffix = extra;
    if (peel) {
      const obj = getObject(repo, oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(oid);
        if (peeled) suffix += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${oid} ${name}${suffix}\n`));
  };
  const head = headRef(repo);
  if (head === ZERO_OID) {
    if (unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    if (keep('HEAD')) {
      const extra = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktLine(`${head} HEAD${extra}\n`));
    }
    const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [name, sha] of refs) pushRef(sha, name);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch (v2)

function refNameForOid(repo: Repo, oid: string): string | null {
  for (const [name, sha] of repo.refs) if (sha === oid) return name;
  return null;
}

export function handleFetch(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let deepenRelative = false;
  let done = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallowBoundaries.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = Number(a.slice(7).trim());
    else if (a === 'deepen-relative') deepenRelative = true;
    else if (a === 'done') done = true;
  }
  // `deepen N` is absolute, except with `deepen-relative` (real git's --deepen):
  // then the new depth is the client's current depth plus N. The current depth
  // is one more than the deepest generation of the shallow boundaries it sent.
  if (depth !== null && deepenRelative) {
    const generationOf = (target: string): number => {
      const seen = new Set<string>();
      const q: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
      while (q.length > 0) {
        const [sha, g] = q.shift()!;
        if (seen.has(sha)) continue;
        seen.add(sha);
        if (sha === target) return g;
        const obj = getObject(repo, sha);
        if (obj && obj.type === 'commit') {
          for (const p of parseCommit(obj.data).parents) q.push([p, g + 1]);
        }
      }
      return -1;
    };
    let maxGen = -1;
    for (const b of shallowBoundaries) maxGen = Math.max(maxGen, generationOf(b));
    const currentDepth = maxGen >= 0 ? maxGen + 1 : 1;
    depth = currentDepth + depth;
  }

  // Resolve wants to commits that exist. A want may be an annotated tag
  // object: resolve it to the commit it peels to, but remember the tag
  // objects themselves — they must be sent in the pack too.
  const wantTags: string[] = [];
  const resolveWant = (sha: string): string | null => {
    const o = getObject(repo, sha);
    if (!o) return null;
    if (o.type === 'commit') return sha;
    if (o.type === 'tag') {
      wantTags.push(sha);
      const target = parseTagTarget(o.data);
      return target ? resolveWant(target) : null;
    }
    return null;
  };
  const wantCommits = wants.map(resolveWant).filter((w): w is string => w !== null);

  const parts: Buffer[] = [];
  // git's v2 fetch: when the client sent `done` there is no negotiation, so the
  // server sends no acknowledgments section at all (git goes straight to the
  // packfile section). Without `done` this is a negotiation round: answer NAK
  // (and stop there), or ACK + ready when a have is common, then the pack.
  const haveSet = new Set(haves);
  let allHeld = wantCommits.length > 0;
  for (const w of wantCommits) {
    if (!haveSet.has(w) && !haves.some((h) => isAncestor(repo, w, h))) allHeld = false;
  }
  // A deepen request always wants more history than the client holds, even when
  // it already has the wanted tip: the tip is held but its ancestors are not.
  if (depth !== null) allHeld = false;
  if (!done) {
    parts.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const h of haves) {
      if (wantCommits.some((w) => isAncestor(repo, h, w) || h === w)) {
        parts.push(pktLine(`ACK ${h}\n`));
        acked = true;
      }
    }
    if (acked) {
      parts.push(pktLine('ready\n'));
      parts.push(pktDelim());
    } else {
      parts.push(pktLine('NAK\n'));
      parts.push(pktFlush());
      return Buffer.concat(parts);
    }
  }

  // Compute the objects to send.
  let objects: Array<{ type: 'commit' | 'tree' | 'blob'; data: Buffer }> = [];
  let shallowOut: string[] = [];
  let unshallowOut: string[] = [];
  // Object shas the client already holds: a have's closure, but the walk stops at
  // a shallow boundary (the client holds the boundary commit itself, not its
  // parents — that is the point of deepening). A shallow boundary on its own
  // contributes only its commit + tree + blobs.
  const boundarySet = new Set(shallowBoundaries);
  const heldShas = (tips: string[]): Set<string> => {
    const out = new Set<string>();
    const queue = [...tips];
    while (queue.length > 0) {
      const sha = queue.pop()!;
      if (out.has(sha)) continue;
      out.add(sha);
      const obj = getObject(repo, sha);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        queue.push(info.tree);
        if (!boundarySet.has(sha)) for (const p of info.parents) queue.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) queue.push(e.sha);
      }
    }
    return out;
  };
  const boundaryShas = (b: string): Set<string> => {
    const out = new Set<string>([b]);
    const obj = getObject(repo, b);
    if (obj && obj.type === 'commit') {
      for (const [path, v] of flattenTreeOfCommit(repo, b)) void path, out.add(v.sha);
    }
    return out;
  };
  if (wantCommits.length > 0 && !allHeld) {
    if (depth !== null) {
      const { objects: objs, shallow } = shallowClosure(repo, wantCommits, depth);
      const exclude = new Set<string>();
      for (const h of haves) for (const s of heldShas([h])) exclude.add(s);
      for (const b of shallowBoundaries) for (const s of boundaryShas(b)) exclude.add(s);
      const sent = new Set<string>();
      objects = objs.filter((o) => {
        const sha = hashObject(o.type, o.data);
        if (exclude.has(sha)) return false;
        sent.add(sha);
        return true;
      });
      shallowOut = shallow.filter((s) => !exclude.has(s));
      // An old boundary is unshallow when this fetch sends one of its parents.
      for (const b of shallowBoundaries) {
        const obj = getObject(repo, b);
        if (obj && obj.type === 'commit') {
          const parents = parseCommit(obj.data).parents;
          if (parents.some((p) => sent.has(p))) unshallowOut.push(b);
        }
      }
    } else {
      const exclude = new Set<string>();
      for (const h of [...haves, ...shallowBoundaries]) for (const s of heldShas([h])) exclude.add(s);
      objects = closureObjects(repo, wantCommits, exclude);
    }
  }

  // Annotated tag objects the client asked for ride along in the pack
  // (closureObjects already follows a tag to its target commit, but the tag
  // object itself is only included when it is a tip — which it is not here).
  if (wantTags.length > 0) {
    const present = new Set(objects.map((o) => hashObject(o.type, o.data)));
    for (const t of wantTags) {
      const obj = getObject(repo, t);
      if (obj && obj.type === 'tag' && !present.has(t)) {
        objects.push(obj);
        present.add(t);
      }
    }
  }

  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
    for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
    parts.push(pktDelim());
  }

  // wanted-refs section: refs pointing at wanted oids (raw wants, so a tag
  // ref lists the tag object itself, not the commit it peels to).
  const wantedRefs: Array<[string, string]> = [];
  for (const w of wants) {
    const name = refNameForOid(repo, w);
    if (name) wantedRefs.push([w, name]);
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const [oid, name] of wantedRefs) parts.push(pktLine(`${oid} ${name}\n`));
    parts.push(pktDelim());
  }

  parts.push(pktLine('packfile\n'));
  const pack = encodePack(objects);
  // Sideband band 1, chunked so each pkt-line stays within the 65520-byte
  // limit: 4 (length) + 1 (band) + data <= 65520, so data <= 65515.
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const banded = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(banded));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack (v0)

export interface PushResult { unpack: 'ok' | string; refs: Array<{ ref: string; ok: boolean; reason: string }> }

/** Apply a receive-pack body. Returns the report-status payload (sideband band 1). */
export async function handleReceivePack(repo: Repo, body: Buffer): Promise<Buffer> {
  const packets = decodePktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = body.length;
  for (let i = 0; i < packets.length; i += 1) {
    const p = packets[i]!;
    if (p.kind === 'flush') {
      // The pack follows the flush packet in the raw body: find its byte offset.
      let off = 0;
      for (let j = 0; j <= i; j += 1) {
        const q = packets[j]!;
        if (q.kind === 'flush') off += 4;
        else if (q.kind === 'delim') off += 4;
        else off += 4 + q.payload.length;
      }
      packStart = off;
      break;
    }
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpack: 'ok' | string = 'ok';
  const packBytes = body.subarray(packStart);
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  let decoded: Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> | null = null;
  if (hasUpdates) {
    if (packBytes.length === 0) {
      unpack = 'unpacker error';
    } else {
      try {
        decoded = await decodePack(packBytes, (sha) => getObject(repo, sha));
        for (const [sha, obj] of decoded) {
          if (!repo.objects.has(sha)) repo.objects.set(sha, obj);
          if (obj.type === 'commit') noteCommit(repo, sha);
        }
      } catch (e) {
        unpack = 'unpacker error';
        void e;
      }
    }
  }

  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (unpack !== 'ok') {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObj = getObject(repo, cmd.newOid);
    const isTagRef = cmd.ref.startsWith('refs/tags/');
    if (!newObj || (isTagRef ? (newObj.type !== 'commit' && newObj.type !== 'tag') : newObj.type !== 'commit')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === ZERO_OID) {
      if (cmd.oldOid !== ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (!isTagRef && !isAncestor(repo, current, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }

  // report-status inside sideband band 1; one pkt-line per report line, like git.
  const lines: Buffer[] = [pktLine(`unpack ${unpack}\n`)];
  for (const r of results) {
    lines.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  lines.push(pktFlush());
  const inner = Buffer.concat(lines);
  // Split the inner stream into sideband packets (each outer pkt-line holds band + chunk);
  // same 65520-byte pkt-line limit as fetch: data <= 65515.
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < inner.length; off += CHUNK) {
    const slice = inner.subarray(off, Math.min(inner.length, off + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}
