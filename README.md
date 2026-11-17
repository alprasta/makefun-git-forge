# makefun-git-forge

A GitHub-compatible git forge for the make.fun bounty
[Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01)
(`github-core-clone-01`), built as `@alprasta`.

One Node process (Node 22, standard library only — no dependencies, no git
binary, no outside service) serves, from a single in-memory store:

- git smart HTTP at `/{owner}/{repo}.git` (protocol v2 upload-pack: ls-refs,
  fetch incl. shallow/deepen; v0 receive-pack with report-status)
- GitHub REST v3 under `/api/v3` (repos, branches, commits, contents, labels,
  issues, comments, pull requests, merges)
- GraphQL at `/api/graphql` (viewer, repository, node, `__type` introspection,
  issue/PR connections with cursors, and the create/close/merge/comment
  mutations)
- MCP at `/mcp` (JSON-RPC 2.0 Streamable HTTP, modern `server/discover` era
  plus the legacy `initialize` handshake; tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`)

State is deterministic: every timestamp and ordering key comes from a logical
counter, never the wall clock or `Math.random()`.

## Local grade

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process --instances 1
```

Last local grades (process driver, Node 22 and Node 24): **964–971 / 1000**
— feature 600/600 (120/120 checks), agent/MCP 200/200, perf 164–179/200.
Replay reproduced in every run. Push workload maxed (50/50) after the pack
decoder was switched to single-inflate via `createInflate` + `bytesWritten`
(exact zlib consumption; binary-search fallback kept). Remaining perf points
are dominated by HTTP round-trip / client overhead on the grading box, not
server CPU.

## Layout

- `main.ts` — the env lifecycle (bind ephemeral port, register, wait for done).
  Kept as the kit starter ships it.
- `app.ts` — the HTTP server: routing, auth, body handling.
- `store.ts` — the store, git object model, pack codec, global ids.
- `git.ts` — smart-HTTP handlers (pkt-lines, advertisements, ls-refs, fetch,
  receive-pack).
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — the GraphQL parser and executor.
- `mcp.ts` — MCP handlers and tools.

## Run

```sh
node --experimental-strip-types main.ts
```

## Licence

MIT
