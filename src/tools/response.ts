/**
 * The shape every tool answers in. See `docs/response-contract.md`.
 *
 * The problem this exists to solve: an empty result used to mean any of "nothing
 * found", "the thing you asked about does not exist", "the language server has
 * not looked yet", and "you are talking to a different workspace than you think".
 * The consumer is an LLM, which cannot tell those apart and so reports the empty
 * result as fact.
 *
 * So a response always carries what was asked, what that resolved to, and which
 * window answered. An empty `results` is then only ever one thing: a genuine
 * absence within a stated scope.
 *
 * Constructors rather than a documented convention, deliberately -- 25 tools
 * remembering to include four fields is how this drifts apart again.
 *
 * @author Sergey Olefir
 */
import * as vscode from 'vscode';

/**
 * What the tool was asked about, and what it resolved that to.
 *
 * `resolved` applies only to requests that name an entity which must be located
 * (a file, a symbol). Its length is the whole story: 0 means not found, 1 means
 * unambiguous, more than 1 means the name matched several things and the caller
 * needs to disambiguate -- which no tool used to report at all.
 *
 * Requests that merely select by predicate (a search query, a glob) leave it
 * undefined: nothing can fail to be found, so empty results are simply empty.
 */
export interface Subject {
  requested: unknown;
  resolved?: unknown[];
}

/** `indeterminate` is absent by design -- it is delivered by throwing, see below. */
export type ResponseStatus = 'ok' | 'not-found';

export interface ToolResponse {
  subject?: Subject;
  /** Which window answered. Always present: this is what makes a misroute visible. */
  scope: string;
  status: ResponseStatus;
  /** False when the answer was cut short (a cap was hit, or part of it was unavailable). */
  complete: boolean;
  /**
   * Why, whenever `status` is not `ok` or `complete` is false. Caveats only --
   * how to read the payload belongs in `format`, so a reader can tell "something
   * is off" from "here is the row layout" without parsing prose.
   */
  reason?: string;
  /** How to read `results` when it uses positional arrays, e.g. "[name, kind, line]". */
  format?: string;
  results: unknown;
}

/**
 * Raised when a tool cannot answer at all -- language server not ready, no folder
 * open, no provider for the language, no debug session.
 *
 * Thrown rather than returned: the bridge turns it into an HTTP failure and the
 * client into an MCP result with `isError: true`, which is what puts it in front
 * of the model. Returning empty results here is the original defect -- it
 * fabricates an answer to a question that was never actually asked.
 */
export class IndeterminateError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'IndeterminateError';
  }
}

/** Names the window that answered, for the `scope` field. */
export function currentScope(): string {
  const name = vscode.workspace.name;
  if (name) {
    return name;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length > 0 ? folders[0].uri.fsPath : '(no workspace open)';
}

/**
 * A tool that ran and answered. Empty `results` is a real answer here -- the
 * subject resolved, there simply is nothing.
 *
 * @param opts.complete pass false when a cap was hit or part of the answer was
 *   unavailable, with `reason` saying which
 */
export function ok(
  results: unknown,
  opts: { subject?: Subject; complete?: boolean; reason?: string; format?: string } = {}
): ToolResponse {
  return {
    ...(opts.subject ? { subject: opts.subject } : {}),
    scope: currentScope(),
    status: 'ok',
    complete: opts.complete ?? true,
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.format ? { format: opts.format } : {}),
    results,
  };
}

/**
 * The thing asked about does not exist in this scope.
 *
 * Not an error: "there is no such file" is a correct answer to a legitimate
 * question, and the caller should not have to catch in order to read it. Only
 * applies to requests that name an entity.
 */
export function notFound(requested: unknown, reason: string): ToolResponse {
  return {
    subject: { requested, resolved: [] },
    scope: currentScope(),
    status: 'not-found',
    complete: true,
    reason,
    results: [],
  };
}
