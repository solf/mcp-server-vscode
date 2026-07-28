# Tool response contract

Status: agreed design, implementation in progress (2026-07-27).

## The problem

Every tool can return an empty result, and an empty result currently means several
incompatible things at once. `diagnostics(uri)` returning `{diagnostics: []}` means
*any* of:

- the file is clean;
- the file does not exist (`vscode.Uri.parse` validates nothing);
- the URI was malformed;
- the file exists but the language server has never analysed it;
- the file belongs to a different workspace than the window that answered.

The fourth is the dangerous one: "no problems" for an unanalysed file is not an
empty answer, it is a false one. `references(symbol) -> []` is worse still --
it means either *no such symbol* or *symbol exists and nothing uses it*, which
are opposite conclusions drawn from identical output.

Two further shapes of the same defect exist today:

- **silent capping**: `workspaceSymbols` stops at `maxFiles` (default 1000) and
  says nothing, so a truncated answer is indistinguishable from a complete one;
- **silent ambiguity**: `references` / `definition` resolve a name to a *set* of
  symbols and answer over it without reporting what matched, so results may be
  the union across unrelated same-named symbols.

The consumer is an LLM. It cannot tell any of these apart, so it states the empty
result as fact and moves on. This is the project's own fail-fast rule violated at
the interface: an empty collection returned for what is really "cannot answer".

## Boundaries

Only one of these is governed by the MCP specification.

```
Agent (Claude / Cursor)
  |  (a) MCP over stdio, JSON-RPC          <-- spec applies HERE, and only here
  v
standalone-server.js  ("the client")
  |  (b) private HTTP API: /tools /tool /health
  v
HTTPBridge  (extension host)
  |  (c) in-process TypeScript calls
  v
tool handlers
```

(b) and (c) are ours to define. They matter only because today they leak straight
through: a handler returning `{error: 'no_session'}` becomes HTTP 200
`{"result":{"error":"no_session"}}` and reaches the agent as a **successful** tool
call whose body happens to mention an error.

Note the client currently inspects `response.error` -- the *top-level* field the
bridge sets on its 500 path -- while a tool's own error sits at
`response.result.error`. Two error conventions at (b), only one of them observed.

## Errors at boundary (a)

Per the MCP spec, tools have two error mechanisms, split by *what* failed:

| mechanism | used for |
|---|---|
| protocol error (JSON-RPC) | unknown tool, invalid arguments, server errors |
| `isError: true` in the result | tool ran and failed: API failures, bad input, business logic |

The SDK states the rationale: errors originating from the tool SHOULD be reported
in the result with `isError: true`, *not* as a protocol error, "otherwise the LLM
would not be able to see that an error occurred and self-correct". A protocol
error is consumed by the client and may never reach the model in usable form.

`tools/list` has no `isError` -- it is not a tool result -- so a failed listing
must be a protocol error. That is already the case: the client throws rather than
returning `{tools: []}`, which is what produced the "1 connected, 0 tools" trap.

## Request shapes

Not every request names one thing, and resolution can be partial. Three shapes:

**A -- locate an entity.** The request names something that must be found first.
`resolved` is a list and its length is the whole story:

```
0  -> not-found          1  -> unambiguous          N  -> ambiguous
```

**B -- select by predicate.** The request is a filter. Nothing can fail to be
found; empty is a legitimate answer. `resolved` does not apply. What matters is
which scope answered, and whether the selection was complete.

**C -- act on required state.** The request needs a precondition (an active debug
session, a stopped thread). A missing precondition is not "not found" -- the
question could not be asked at all.

Shape C tools are **commands, not questions**, and are the one documented
exception to the envelope. `debug_stepOver` answering `{status: 'Stepped over',
threadId, action: 'next'}` has no subject to resolve, cannot be not-found, and
has nothing for `complete` to mean; wrapping it would add empty ceremony and
collide with its own `status` field, which describes the step rather than the
response. They carry **`scope` only** -- "which window did I just step in?" is a
real question once every window runs its own bridge.

The exception is exactly: `debug_stepOver` `debug_stepInto` `debug_stepOut`
`debug_continueExecution` `debug_pauseExecution` `debug_stopSession`
`debug_clearBreakpoints`. Every other tool, debug ones included, uses the
envelope.

## Envelope

One shape for every tool:

```jsonc
{
  "subject": { "requested": "process",
               "resolved":  [ {...}, {...} ] },   // shape A only
  "scope":    "dsp-etl (Workspace)",
  "status":   "ok" | "not-found" | "indeterminate",
  "complete": true,
  "reason":   "capped at maxFiles=1000",          // caveats: when !ok or !complete
  "format":   "[name, kind, uri, line]",          // how to read positional results
  "results":  [ ... ]
}
```

`reason` and `format` are separate on purpose. `reason` means "something about
this answer is off"; `format` means "here is the row layout". Carrying a schema
hint in `reason` would make a caveat indistinguishable from documentation, and
the two are not mutually exclusive -- a truncated compact result needs both.

`indeterminate` never appears in a returned envelope: it is delivered by throwing
`IndeterminateError`, which the bridge turns into a 503 and the client into
`isError: true`. Successful envelopes carry only `ok` or `not-found`.

| status | `isError` | meaning |
|---|---|---|
| `ok` | no | subject resolved; `results` is the truth, empty included |
| `not-found` | no | subject does not exist in this scope (shape A only) |
| `indeterminate` | **yes** | could not answer: LS not ready, no folder open, no provider, no session |

Two deliberate choices:

- **`not-found` is not an error.** "There is no such file" is a correct answer to
  a legitimate question, and the caller should not have to catch to read it.
- **`indeterminate` is an error.** The tool could not answer, so any data it
  returned would be fabricated. This is the case that has been lying to us.

And two things kept *out* of `status`:

- **Ambiguity needs no status** -- `resolved.length > 1` already says it.
- **`complete` is orthogonal** -- a result can be `ok` and incomplete (capped,
  or some files not yet analysed). Folding truncation into `status` would force
  a false choice between "succeeded" and "was cut short".

`scope` is present on every response, always. It is a few tokens, and it is what
makes a cross-window misroute self-evident rather than silent.

## Per-tool subjects

| tool | shape | subject | `not-found` when |
|---|---|---|---|
| `diagnostics(uri)` | A | file | URI does not resolve to a file |
| `diagnostics()` | B | workspace | n/a |
| `definition`, `hover`, `references`, `callHierarchy` | A | symbol | no symbol of that name |
| `refactor_rename` | A | symbol | no symbol of that name |
| `symbolSearch(query, kind?)` | B | query | n/a |
| `workspaceSymbols(filePattern?)` | B | file set | n/a |
| `debug_setBreakpoint`, `debug_toggleBreakpoint` | A | location | symbol/file unresolvable |
| `debug_startSession(configuration?)` | A | launch config | no config of that name |
| `debug_listBreakpoints`, `debug_listConfigurations`, `debug_getOutput` | B | enumeration | n/a |
| all other `debug_*` | C | debug session | n/a (missing session -> `indeterminate`) |

Special cases worth stating explicitly:

- **`diagnostics(uri)` on a file that exists but has not been analysed is
  `indeterminate`, not `ok`.** Reporting zero problems for a file the language
  server has never seen is the original bug.
- **`refactor_rename` must refuse when `resolved.length > 1`.** It mutates files;
  renaming whichever candidate it happened to pick is a correctness hazard, not
  an ambiguity to paper over.
- **`workspaceSymbols` must set `complete: false`** when it stops at `maxFiles`.

## Implementation notes

Resolution is inherently per-tool -- only `diagnostics` knows how to check a
file, only `references` knows how to resolve a symbol. The **envelope** must not
be: three constructors in `src/tools/response.ts` --

```ts
ok(subject, results, opts?)   notFound(subject, reason)   indeterminate(reason)
```

-- so the shape is enforced by construction rather than by 25 authors remembering
a convention. That is what stops it drifting apart again.

At (b), tool handlers signal failure by **throwing**; the bridge's existing
500 + `{error}` path carries it. `{error: code}` must never again be returned as
a successful payload. At (a), the client maps that to `isError: true`.

Cost: roughly 20-40 tokens per response. That is real, given `compact` exists for
token efficiency -- and trivial beside an agent reporting "no errors" for a file
nothing ever analysed.
