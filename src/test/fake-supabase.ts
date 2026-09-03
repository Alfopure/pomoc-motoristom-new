import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/**
 * In-memory stand-in for the Supabase client used by the telephony server
 * modules. It implements the subset of PostgREST query building the code base
 * relies on (`from().select/insert/upsert/update/delete` with `eq/neq/in/is/
 * not/gt/gte/lt/lte/like/ilike/order/limit/range/single/maybeSingle`) plus
 * `rpc()` with handlers that reproduce the semantics of the five telephony
 * RPCs from `20260903100000_telnyx_telephony_foundation.sql`.
 *
 * It is not a SQL engine: no joins, no embedded resources, no policies. Its
 * purpose is deterministic, offline tests of reducers and workflows.
 */

export type FakeRow = Record<string, unknown>;

export type FakeError = {
  message: string;
  code: string;
  details: string | null;
  hint: string | null;
};

export type FakeResult<T = unknown> = {
  data: T;
  error: FakeError | null;
  count: number | null;
  status: number;
  statusText: string;
};

export type FakeRpcHandler = (args: FakeRow, db: FakeDatabase) => unknown | Promise<unknown>;

export type FakeOperation = "select" | "insert" | "upsert" | "update" | "delete" | "rpc";

export type FakeLogEntry = {
  kind: "query" | "rpc";
  table: string;
  operation: FakeOperation;
  payload?: unknown;
  filters?: string[];
};

type Filter = (row: FakeRow) => boolean;

type OrderSpec = { column: string; ascending: boolean; nullsFirst: boolean };

type ErrorInjection = { table: string; operation: FakeOperation | "*"; error: FakeError };

/** Natural keys used to emulate unique constraints of the telephony schema. */
export const DEFAULT_UNIQUE_KEYS: Record<string, string[][]> = {
  motorist_telnyx_webhook_events: [["event_id"]],
  motorist_call_sessions: [["id"], ["telnyx_session_id"]],
  motorist_call_legs: [["id"], ["telnyx_call_control_id"], ["telnyx_call_leg_id"]],
  motorist_ring_attempts: [["id"], ["session_id", "step_index", "profile_id"], ["session_id", "step_index", "external_number"]],
  motorist_operator_presence: [["id"], ["profile_id"]],
  motorist_operator_devices: [["id"], ["profile_id", "environment"]],
  motorist_operator_telephony_settings: [["id"], ["profile_id"]],
  motorist_telephony_settings: [["id"], ["organization_id"]],
  motorist_telephony_daily_usage: [["id"], ["organization_id", "day"]],
  motorist_telephony_lines: [["id"], ["organization_id", "phone_number"]],
  motorist_calls: [["id"]],
  motorist_call_events: [["id"], ["event_fingerprint"]],
};

export function fakeError(message: string, code = "FAKE", details: string | null = null): FakeError {
  return { message, code, details, hint: null };
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (isNil(left) || isNil(right)) return false;
  if (typeof left === "object" || typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return String(left) === String(right);
}

function compare(left: unknown, right: unknown): number {
  if (isNil(left) && isNil(right)) return 0;
  if (isNil(left)) return 1;
  if (isNil(right)) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, caseInsensitive ? "i" : "");
}

function projectRow(row: FakeRow, columns: string | undefined): FakeRow {
  if (!columns || columns.trim() === "*" || columns.includes("(")) return clone(row);
  const wanted = columns
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.includes(":") ? part.split(":")[1].trim() : part));
  if (wanted.includes("*")) return clone(row);
  const projected: FakeRow = {};
  for (const column of wanted) projected[column] = clone(row[column]);
  return projected;
}

export class FakeDatabase {
  readonly tables = new Map<string, FakeRow[]>();
  readonly rpcHandlers = new Map<string, FakeRpcHandler>();
  readonly log: FakeLogEntry[] = [];
  readonly uniqueKeys: Record<string, string[][]>;
  private readonly injections: ErrorInjection[] = [];
  private clock: () => Date;

  constructor(options: { now?: () => Date; uniqueKeys?: Record<string, string[][]> } = {}) {
    this.clock = options.now ?? (() => new Date());
    this.uniqueKeys = { ...DEFAULT_UNIQUE_KEYS, ...(options.uniqueKeys ?? {}) };
    registerTelephonyRpcs(this);
  }

  /** Current time of the fake database (`now()` in SQL terms). */
  now(): Date {
    return this.clock();
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  setNow(next: Date | (() => Date)): void {
    this.clock = typeof next === "function" ? next : () => next;
  }

  /** Moves a fixed clock forward; no-op semantics for dynamic clocks are avoided by fixing the current instant. */
  advance(ms: number): void {
    const current = this.now().getTime();
    this.setNow(new Date(current + ms));
  }

  seed(table: string, rows: FakeRow[]): FakeRow[] {
    return this.insert(table, rows);
  }

  rows(table: string): FakeRow[] {
    return clone(this.storage(table));
  }

  find(table: string, predicate: (row: FakeRow) => boolean): FakeRow | null {
    const row = this.storage(table).find(predicate);
    return row ? clone(row) : null;
  }

  registerRpc(name: string, handler: FakeRpcHandler): void {
    this.rpcHandlers.set(name, handler);
  }

  /** The next matching operation fails with `error` (consumed once). */
  failNext(table: string, operation: FakeOperation | "*", error: FakeError | string): void {
    this.injections.push({ table, operation, error: typeof error === "string" ? fakeError(error) : error });
  }

  takeInjectedError(table: string, operation: FakeOperation): FakeError | null {
    const index = this.injections.findIndex((entry) => entry.table === table && (entry.operation === "*" || entry.operation === operation));
    if (index === -1) return null;
    const [entry] = this.injections.splice(index, 1);
    return entry.error;
  }

  storage(table: string): FakeRow[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  private withDefaults(row: FakeRow): FakeRow {
    const next: FakeRow = { ...row };
    if (isNil(next.id)) next.id = randomUUID();
    if (!("created_at" in next) || isNil(next.created_at)) next.created_at = this.nowIso();
    if (!("updated_at" in next) || isNil(next.updated_at)) next.updated_at = this.nowIso();
    return next;
  }

  private findConflict(table: string, row: FakeRow, exclude?: FakeRow): { key: string[]; existing: FakeRow } | null {
    for (const key of this.uniqueKeys[table] ?? [["id"]]) {
      if (key.some((column) => isNil(row[column]))) continue;
      const existing = this.storage(table).find((candidate) => candidate !== exclude && key.every((column) => sameValue(candidate[column], row[column])));
      if (existing) return { key, existing };
    }
    return null;
  }

  insert(table: string, rows: FakeRow | FakeRow[]): FakeRow[] {
    const list = Array.isArray(rows) ? rows : [rows];
    const prepared = list.map((row) => this.withDefaults(clone(row)));
    for (const row of prepared) {
      const conflict = this.findConflict(table, row);
      if (conflict) {
        throw fakeError(
          `duplicate key value violates unique constraint "${table}_${conflict.key.join("_")}_key"`,
          "23505",
          `Key (${conflict.key.join(", ")}) already exists.`,
        );
      }
      this.storage(table).push(row);
    }
    return clone(prepared);
  }

  upsert(table: string, rows: FakeRow | FakeRow[], options: { onConflict?: string; ignoreDuplicates?: boolean } = {}): FakeRow[] {
    const list = Array.isArray(rows) ? rows : [rows];
    const target = options.onConflict
      ? options.onConflict.split(",").map((column) => column.trim())
      : null;
    const results: FakeRow[] = [];
    for (const raw of list) {
      const row = clone(raw);
      const keys = target ? [target] : this.uniqueKeys[table] ?? [["id"]];
      let existing: FakeRow | undefined;
      for (const key of keys) {
        if (key.some((column) => isNil(row[column]))) continue;
        existing = this.storage(table).find((candidate) => key.every((column) => sameValue(candidate[column], row[column])));
        if (existing) break;
      }
      if (existing) {
        if (options.ignoreDuplicates) {
          results.push(clone(existing));
          continue;
        }
        Object.assign(existing, row, { updated_at: this.nowIso() });
        const conflict = this.findConflict(table, existing, existing);
        if (conflict) throw fakeError(`duplicate key value violates unique constraint (${conflict.key.join(", ")})`, "23505");
        results.push(clone(existing));
      } else {
        results.push(...this.insert(table, row));
      }
    }
    return results;
  }

  update(table: string, values: FakeRow, filter: Filter): FakeRow[] {
    const updated: FakeRow[] = [];
    for (const row of this.storage(table)) {
      if (!filter(row)) continue;
      Object.assign(row, clone(values));
      if ("updated_at" in row && !("updated_at" in values)) row.updated_at = this.nowIso();
      const conflict = this.findConflict(table, row, row);
      if (conflict) throw fakeError(`duplicate key value violates unique constraint (${conflict.key.join(", ")})`, "23505");
      updated.push(clone(row));
    }
    return updated;
  }

  delete(table: string, filter: Filter): FakeRow[] {
    const rows = this.storage(table);
    const removed = rows.filter(filter);
    this.tables.set(table, rows.filter((row) => !filter(row)));
    return clone(removed);
  }

  select(table: string, filter: Filter): FakeRow[] {
    return this.storage(table).filter(filter);
  }
}

/** Thenable query builder mirroring the PostgREST fluent API. */
export class FakeQueryBuilder implements PromiseLike<FakeResult> {
  private operation: FakeOperation = "select";
  private payload: unknown;
  private columns: string | undefined;
  private readonly filters: Filter[] = [];
  private readonly filterLabels: string[] = [];
  private readonly orders: OrderSpec[] = [];
  private limitCount: number | null = null;
  private rangeSpec: { from: number; to: number } | null = null;
  private mode: "many" | "single" | "maybeSingle" = "many";
  private returning = false;
  private countMode: "exact" | null = null;
  private headOnly = false;
  private upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private rpcResult: (() => Promise<unknown>) | null = null;

  constructor(
    private readonly db: FakeDatabase,
    private readonly table: string,
  ) {}

  // --- verbs -------------------------------------------------------------

  select(columns?: string, options: { count?: "exact" | "planned" | "estimated"; head?: boolean } = {}): this {
    if (this.operation === "select") {
      this.columns = columns;
    } else {
      this.returning = true;
      this.columns = columns;
    }
    if (options.count) this.countMode = "exact";
    if (options.head) this.headOnly = true;
    return this;
  }

  insert(values: FakeRow | FakeRow[]): this {
    this.operation = "insert";
    this.payload = values;
    return this;
  }

  upsert(values: FakeRow | FakeRow[], options: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    this.operation = "upsert";
    this.payload = values;
    this.upsertOptions = options;
    return this;
  }

  update(values: FakeRow): this {
    this.operation = "update";
    this.payload = values;
    return this;
  }

  delete(): this {
    this.operation = "delete";
    return this;
  }

  /** Internal: used by `rpc()` so the result supports `.single()` etc. */
  asRpc(run: () => Promise<unknown>): this {
    this.operation = "rpc";
    this.rpcResult = run;
    return this;
  }

  // --- filters -----------------------------------------------------------

  private addFilter(label: string, filter: Filter): this {
    this.filters.push(filter);
    this.filterLabels.push(label);
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.addFilter(`eq(${column})`, (row) => sameValue(row[column], value));
  }

  neq(column: string, value: unknown): this {
    return this.addFilter(`neq(${column})`, (row) => !sameValue(row[column], value));
  }

  in(column: string, values: readonly unknown[]): this {
    return this.addFilter(`in(${column})`, (row) => values.some((value) => sameValue(row[column], value)));
  }

  is(column: string, value: null | boolean): this {
    return this.addFilter(`is(${column})`, (row) => (value === null ? isNil(row[column]) : row[column] === value));
  }

  not(column: string, operator: "is" | "eq" | "in", value: unknown): this {
    return this.addFilter(`not.${operator}(${column})`, (row) => {
      if (operator === "is") return value === null ? !isNil(row[column]) : row[column] !== value;
      if (operator === "eq") return !sameValue(row[column], value);
      return !(value as unknown[]).some((candidate) => sameValue(row[column], candidate));
    });
  }

  gt(column: string, value: unknown): this {
    return this.addFilter(`gt(${column})`, (row) => !isNil(row[column]) && compare(row[column], value) > 0);
  }

  gte(column: string, value: unknown): this {
    return this.addFilter(`gte(${column})`, (row) => !isNil(row[column]) && compare(row[column], value) >= 0);
  }

  lt(column: string, value: unknown): this {
    return this.addFilter(`lt(${column})`, (row) => !isNil(row[column]) && compare(row[column], value) < 0);
  }

  lte(column: string, value: unknown): this {
    return this.addFilter(`lte(${column})`, (row) => !isNil(row[column]) && compare(row[column], value) <= 0);
  }

  like(column: string, pattern: string): this {
    const regexp = likeToRegExp(pattern, false);
    return this.addFilter(`like(${column})`, (row) => typeof row[column] === "string" && regexp.test(row[column] as string));
  }

  ilike(column: string, pattern: string): this {
    const regexp = likeToRegExp(pattern, true);
    return this.addFilter(`ilike(${column})`, (row) => typeof row[column] === "string" && regexp.test(row[column] as string));
  }

  /** Accepts PostgREST `or("a.eq.1,b.is.null")` for the simple operators. */
  or(expression: string): this {
    const clauses = expression.split(",").map((clause) => clause.trim()).filter(Boolean);
    return this.addFilter(`or(${expression})`, (row) =>
      clauses.some((clause) => {
        const [column, operator, ...rest] = clause.split(".");
        const raw = rest.join(".");
        const value = raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
        switch (operator) {
          case "eq":
            return sameValue(row[column], value);
          case "neq":
            return !sameValue(row[column], value);
          case "is":
            return value === null ? isNil(row[column]) : row[column] === value;
          case "gt":
            return !isNil(row[column]) && compare(row[column], value) > 0;
          case "gte":
            return !isNil(row[column]) && compare(row[column], value) >= 0;
          case "lt":
            return !isNil(row[column]) && compare(row[column], value) < 0;
          case "lte":
            return !isNil(row[column]) && compare(row[column], value) <= 0;
          default:
            throw new Error(`fake-supabase: unsupported or() operator "${operator}"`);
        }
      }),
    );
  }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    this.orders.push({ column, ascending: options.ascending ?? true, nullsFirst: options.nullsFirst ?? !(options.ascending ?? true) });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeSpec = { from, to };
    return this;
  }

  single(): this {
    this.mode = "single";
    return this;
  }

  maybeSingle(): this {
    this.mode = "maybeSingle";
    return this;
  }

  // --- execution ---------------------------------------------------------

  private matches(row: FakeRow): boolean {
    return this.filters.every((filter) => filter(row));
  }

  private sortAndSlice(rows: FakeRow[]): FakeRow[] {
    let result = [...rows];
    for (const spec of [...this.orders].reverse()) {
      result.sort((a, b) => {
        const left = a[spec.column];
        const right = b[spec.column];
        if (isNil(left) && isNil(right)) return 0;
        if (isNil(left)) return spec.nullsFirst ? -1 : 1;
        if (isNil(right)) return spec.nullsFirst ? 1 : -1;
        const order = compare(left, right);
        return spec.ascending ? order : -order;
      });
    }
    if (this.rangeSpec) result = result.slice(this.rangeSpec.from, this.rangeSpec.to + 1);
    if (this.limitCount !== null) result = result.slice(0, this.limitCount);
    return result;
  }

  private finish(rows: FakeRow[] | null): FakeResult {
    const count = this.countMode && rows ? rows.length : null;
    if (this.headOnly) return { data: null, error: null, count, status: 200, statusText: "OK" };
    if (rows === null) return { data: null, error: null, count, status: 204, statusText: "No Content" };

    const projected = rows.map((row) => projectRow(row, this.columns));
    if (this.mode === "single") {
      if (projected.length !== 1) {
        return {
          data: null,
          error: fakeError(
            projected.length === 0 ? "JSON object requested, multiple (or no) rows returned" : "JSON object requested, multiple (or no) rows returned",
            "PGRST116",
            `The result contains ${projected.length} rows`,
          ),
          count,
          status: 406,
          statusText: "Not Acceptable",
        };
      }
      return { data: projected[0], error: null, count, status: 200, statusText: "OK" };
    }
    if (this.mode === "maybeSingle") {
      if (projected.length > 1) {
        return {
          data: null,
          error: fakeError("JSON object requested, multiple (or no) rows returned", "PGRST116", `The result contains ${projected.length} rows`),
          count,
          status: 406,
          statusText: "Not Acceptable",
        };
      }
      return { data: projected[0] ?? null, error: null, count, status: 200, statusText: "OK" };
    }
    return { data: projected, error: null, count, status: 200, statusText: "OK" };
  }

  private async execute(): Promise<FakeResult> {
    if (this.operation === "rpc" && this.rpcResult) {
      const value = await this.rpcResult();
      if (Array.isArray(value)) return this.finish(value as FakeRow[]);
      return { data: value ?? null, error: null, count: null, status: 200, statusText: "OK" };
    }

    this.db.log.push({ kind: "query", table: this.table, operation: this.operation, payload: clone(this.payload), filters: [...this.filterLabels] });

    const injected = this.db.takeInjectedError(this.table, this.operation);
    if (injected) return { data: null, error: injected, count: null, status: 500, statusText: "Injected" };

    try {
      switch (this.operation) {
        case "select":
          return this.finish(this.sortAndSlice(this.db.select(this.table, (row) => this.matches(row))));
        case "insert": {
          const rows = this.db.insert(this.table, this.payload as FakeRow | FakeRow[]);
          return this.finish(this.returning ? rows : null);
        }
        case "upsert": {
          const rows = this.db.upsert(this.table, this.payload as FakeRow | FakeRow[], this.upsertOptions);
          return this.finish(this.returning ? rows : null);
        }
        case "update": {
          const rows = this.db.update(this.table, this.payload as FakeRow, (row) => this.matches(row));
          return this.finish(this.returning ? this.sortAndSlice(rows) : null);
        }
        case "delete": {
          const rows = this.db.delete(this.table, (row) => this.matches(row));
          return this.finish(this.returning ? this.sortAndSlice(rows) : null);
        }
        default:
          throw new Error(`fake-supabase: unsupported operation ${this.operation}`);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && "message" in error) {
        const failure = error as FakeError;
        return { data: null, error: failure, count: null, status: failure.code === "23505" ? 409 : 400, statusText: "Error" };
      }
      throw error;
    }
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export type FakeSupabaseClient = {
  from(table: string): FakeQueryBuilder;
  rpc(name: string, args?: FakeRow): FakeQueryBuilder;
};

export type FakeSupabase = {
  db: FakeDatabase;
  client: FakeSupabaseClient;
  /** The same client cast to the typed Supabase client so it can be handed to production modules. */
  admin: SupabaseClient<Database>;
};

export function createFakeSupabase(options: { now?: () => Date; uniqueKeys?: Record<string, string[][]> } = {}): FakeSupabase {
  const db = new FakeDatabase(options);
  const client: FakeSupabaseClient = {
    from(table) {
      return new FakeQueryBuilder(db, table);
    },
    rpc(name, args = {}) {
      return new FakeQueryBuilder(db, name).asRpc(async () => {
        db.log.push({ kind: "rpc", table: name, operation: "rpc", payload: clone(args) });
        const injected = db.takeInjectedError(name, "rpc");
        if (injected) throw injected;
        const handler = db.rpcHandlers.get(name);
        if (!handler) throw fakeError(`function public.${name} does not exist`, "42883");
        return handler(args, db);
      });
    },
  };
  // rpc failures surface as `{ error }` like PostgREST, not as thrown errors.
  const wrapped: FakeSupabaseClient = {
    from: client.from,
    rpc(name, args) {
      const builder = client.rpc(name, args);
      const originalThen = builder.then.bind(builder);
      builder.then = (onfulfilled, onrejected) =>
        originalThen(undefined, (reason: unknown) => {
          if (reason && typeof reason === "object" && "code" in reason && "message" in reason) {
            return { data: null, error: reason as FakeError, count: null, status: 400, statusText: "Error" } satisfies FakeResult;
          }
          throw reason;
        }).then(onfulfilled, onrejected);
      return builder;
    },
  };
  return { db, client: wrapped, admin: wrapped as unknown as SupabaseClient<Database> };
}

// ---------------------------------------------------------------------------
// RPC semantics (mirrors of the SQL bodies in the foundation migration)
// ---------------------------------------------------------------------------

function toMs(value: unknown): number | null {
  if (isNil(value)) return null;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

export function registerTelephonyRpcs(db: FakeDatabase): void {
  db.registerRpc("motorist_telnyx_claim_webhook_event", (args) => {
    const table = "motorist_telnyx_webhook_events";
    const eventId = String(args.p_event_id);
    const staleMs = Math.max(1000, Number(args.p_stale_after_ms ?? 30000));
    const nowMs = db.now().getTime();
    const existing = db.storage(table).find((row) => row.event_id === eventId);

    if (!existing) {
      const row: FakeRow = {
        event_id: eventId,
        organization_id: args.p_organization_id ?? null,
        event_type: String(args.p_event_type),
        call_session_id: args.p_call_session_id ?? null,
        call_leg_id: args.p_call_leg_id ?? null,
        call_control_id: args.p_call_control_id ?? null,
        connection_id: args.p_connection_id ?? null,
        status: "queued",
        attempts: 1,
        claimed_at: db.nowIso(),
        error: null,
        payload: args.p_payload ?? null,
        occurred_at: args.p_occurred_at ?? null,
        received_at: db.nowIso(),
        processed_at: null,
      };
      db.storage(table).push(row);
      return [{ outcome: "claimed", event_status: "queued", event_attempts: 1 }];
    }

    if (existing.status === "processed") {
      return [{ outcome: "duplicate", event_status: existing.status, event_attempts: existing.attempts }];
    }

    const claimedAt = toMs(existing.claimed_at);
    if (claimedAt !== null && claimedAt > nowMs - staleMs) {
      return [{ outcome: "busy", event_status: existing.status, event_attempts: existing.attempts }];
    }

    existing.claimed_at = db.nowIso();
    existing.attempts = Number(existing.attempts ?? 0) + 1;
    existing.payload = existing.payload ?? args.p_payload ?? null;
    existing.organization_id = existing.organization_id ?? args.p_organization_id ?? null;
    return [{ outcome: "claimed", event_status: existing.status, event_attempts: existing.attempts }];
  });

  db.registerRpc("motorist_session_lease_acquire", (args) => {
    const session = db.storage("motorist_call_sessions").find((row) => row.id === args.p_session_id);
    if (!session) return false;
    const nowMs = db.now().getTime();
    const until = toMs(session.lease_until);
    const free = until === null || until < nowMs || session.lease_token === args.p_token;
    if (!free) return false;
    const ttl = Math.max(250, Math.min(Number(args.p_ttl_ms ?? 4000), 30000));
    session.lease_token = String(args.p_token);
    session.lease_until = new Date(nowMs + ttl).toISOString();
    return true;
  });

  db.registerRpc("motorist_session_lease_release", (args) => {
    const session = db.storage("motorist_call_sessions").find((row) => row.id === args.p_session_id);
    if (!session || session.lease_token !== args.p_token) return false;
    session.lease_token = null;
    session.lease_until = null;
    return true;
  });

  db.registerRpc("motorist_reserve_operator", (args) => {
    const presence = db.storage("motorist_operator_presence").find((row) => row.profile_id === args.p_profile_id);
    if (!presence) return false;
    const eligibleStatus = ["available", "ringing", "after_call_work"].includes(String(presence.status));
    const sessionFree = isNil(presence.current_session_id) || presence.current_session_id === args.p_session_id;
    if (!eligibleStatus || !sessionFree) return false;
    presence.status = "on_call";
    presence.current_session_id = args.p_session_id;
    presence.wrap_up_until = null;
    presence.status_since = db.nowIso();
    presence.updated_at = db.nowIso();
    return true;
  });

  db.registerRpc("motorist_advance_ring_step", (args) => {
    const session = db.storage("motorist_call_sessions").find((row) => row.id === args.p_session_id);
    if (!session || Number(session.current_step) !== Number(args.p_expected_step)) return false;
    session.current_step = Number(args.p_expected_step) + 1;
    session.version = Number(session.version ?? 0) + 1;
    session.updated_at = db.nowIso();
    return true;
  });
}
