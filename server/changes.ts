import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import type { ChangeScope } from '../src/lib/change-scopes';

/** The client data a write to each table can change. Bookkeeping that no screen shows maps to nothing.
 * Every table must be listed here (tests enforce it), so a new table cannot silently skip notifications. */
export const TABLE_SCOPES: Readonly<Record<string, readonly ChangeScope[]>> = {
  tasks: ['tasks'], task_tags: ['tasks'], runs: ['tasks'], comments: ['tasks'], task_logs: ['tasks'],
  attachments: ['tasks'], task_attachment_links: ['tasks'], comment_attachment_links: ['tasks'], run_attachment_inputs: ['tasks'],
  followup_requests: ['tasks'], execution_requests: ['tasks'], integrations: ['tasks'], workspaces: ['tasks'],
  // A turn's usage shows in its run, the autopilot report (which follows tasks) and the worker totals.
  run_usage: ['tasks', 'workers'],
  autopilot: ['autopilot'],
  instructions: ['instructions'],
  doc_pages: ['docs'], doc_images: ['docs'], doc_search: ['docs'],
  workers: ['workers'], integrator_profile: ['workers'],
  tags: ['tags'],
  general_settings: ['settings'], autopilot_settings: ['settings'], check_triage_settings: ['settings'],
  cli_access_settings: ['settings'], concurrency_settings: ['settings'], model_catalog: ['settings'],
  // Content-addressed uploads, idempotency records, cached diffs and the process lease.
  avatars: [], attachment_publications: [], task_tool_operations: [], mcp_tool_operations: [],
  run_code_diffs: [], service_lease: [], app_migrations: [],
};

const WRITES = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE\s+(?:OR\s+\w+\s+)?|DELETE\s+FROM)\s*["`[]?(\w+)/gi;
const parsed = new Map<string, readonly ChangeScope[]>();

/** Scopes touched by a statement; empty for reads and for the DDL keywords the pattern also meets (`ON UPDATE`, `DO UPDATE SET`). */
export function writeScopes(sql: string): readonly ChangeScope[] {
  let scopes = parsed.get(sql);
  if (!scopes) {
    const found = new Set<ChangeScope>();
    for (const [, table] of sql.matchAll(WRITES)) for (const scope of TABLE_SCOPES[table!.toLowerCase()] ?? []) found.add(scope);
    scopes = [...found];
    if (parsed.size < 2_000) parsed.set(sql, scopes);
  }
  return scopes;
}

type Bindings = SQLQueryBindings | SQLQueryBindings[];
type Params<P> = P extends any[] ? P : [P];
const wrapped = new WeakSet<object>();

/** A connection that reports which scopes each write touched, without changing how statements or transactions run.
 * A write inside a transaction is reported before the commit and also when it rolls back: a listener must only schedule a reload. */
export class ChangeTrackingDatabase extends Database {
  onWrite: ((scopes: readonly ChangeScope[]) => void) | null = null;

  override query<R, P extends Bindings>(sql: string): Statement<R, Params<P>> {
    return this.track(super.query<R, P>(sql), sql);
  }
  override prepare<R, P extends Bindings>(sql: string, params?: P): Statement<R, Params<P>> {
    return this.track(super.prepare<R, P>(sql, params), sql);
  }
  override run<P extends SQLQueryBindings[]>(sql: string, ...bindings: P[]) {
    const result = super.run(sql, ...bindings);
    this.report(writeScopes(sql));
    return result;
  }
  override exec<P extends SQLQueryBindings[]>(sql: string, ...bindings: P[]) {
    const result = super.exec(sql, ...bindings);
    this.report(writeScopes(sql));
    return result;
  }

  private report(scopes: readonly ChangeScope[]) {
    if (scopes.length) this.onWrite?.(scopes);
  }

  private track<S extends Statement<any, any[]>>(statement: S, sql: string): S {
    const scopes = writeScopes(sql);
    if (!scopes.length || wrapped.has(statement)) return statement;
    wrapped.add(statement);
    const { run, get, all, values } = statement;
    // An UPDATE or DELETE that matched no row changed nothing the interface could show.
    statement.run = (...args: any[]) => { const result = run.apply(statement, args); if (result.changes > 0) this.report(scopes); return result; };
    // RETURNING statements: report every execution.
    statement.get = (...args: any[]) => { const result = get.apply(statement, args); this.report(scopes); return result; };
    statement.all = (...args: any[]) => { const result = all.apply(statement, args); this.report(scopes); return result; };
    statement.values = (...args: any[]) => { const result = values.apply(statement, args); this.report(scopes); return result; };
    return statement;
  }
}
