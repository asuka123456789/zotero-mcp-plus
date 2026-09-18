export const PLUS_PREF_PREFIX = "extensions.zotero.zotero-mcp-plus";
export const PLUS_PROTOCOL_VERSION = "2025-11-25";
export const PLAN_VERSION = 1;

export type JsonObject = Record<string, any>;

export class PlusError extends Error {
  code: string;
  details?: JsonObject;
  constructor(code: string, message: string, details?: JsonObject) {
    super(message);
    this.name = "PlusError";
    this.code = code;
    this.details = details;
  }
}

export interface TargetRef {
  libraryID: number;
  key: string;
  kind: "item" | "collection" | "library";
}

export interface PlanStep {
  id: string;
  input: JsonObject;
  targets: TargetRef[];
  fingerprint: string;
  preview: JsonObject;
  skipReason?: string;
  blockers?: Array<{ code: string; message: string }>;
}

export interface OperationPlan {
  schemaVersion: 1;
  tool: string;
  libraryID: number;
  params: JsonObject;
  steps: PlanStep[];
  warnings: string[];
}

export type StepState =
  | "pending"
  | "submitted"
  | "running"
  | "succeeded"
  | "externally_satisfied"
  | "skipped"
  | "failed"
  | "cancelled"
  | "needs_review";

export interface StepOutcome {
  state:
    | "succeeded"
    | "externally_satisfied"
    | "skipped"
    | "failed"
    | "needs_review";
  result?: JsonObject;
  error?: { code: string; message: string };
  // 只有能证明没有副作用，才允许显式重试。
  retrySafe?: boolean;
}

export interface ExecutionContext {
  taskID: string;
  attemptID: string;
  signal: AbortSignal;
  update(phase: "submitted" | "running", details?: JsonObject): Promise<void>;
}

export interface OperationAdapter {
  tool: string;
  lane: "recognition" | "mutation" | "identifier";
  prepare(args: JsonObject): Promise<OperationPlan>;
  check(step: PlanStep): Promise<void>;
  execute(step: PlanStep, context: ExecutionContext): Promise<StepOutcome>;
  reconcile(step: PlanStep): Promise<StepOutcome>;
}

export function canonicalJSON(value: unknown): string {
  const visit = (input: any): any => {
    if (input === undefined) return null;
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(visit);
    const result: JsonObject = Object.create(null);
    for (const key of Object.keys(input).sort()) {
      if (input[key] !== undefined) result[key] = visit(input[key]);
    }
    return result;
  };
  return JSON.stringify(visit(value));
}

function runtimeCrypto() {
  const crypto =
    globalThis.crypto ??
    (typeof Zotero !== "undefined"
      ? Zotero.getMainWindow()?.crypto
      : undefined);
  if (!crypto?.getRandomValues || !crypto.subtle) {
    throw new PlusError(
      "CRYPTO_UNAVAILABLE",
      "当前环境没有可用的安全随机数和摘要接口",
    );
  }
  return crypto;
}

export function secureID(prefix = "plus"): string {
  const bytes = new Uint8Array(24);
  runtimeCrypto().getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJSON(value));
  const digest = await runtimeCrypto().subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function targetID(target: TargetRef): string {
  return `${target.libraryID}:${target.kind}:${target.key}`;
}

export function requireLibraryID(value: unknown): number {
  const id = value === undefined ? Zotero.Libraries.userLibraryID : value;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new PlusError("INVALID_ARGUMENT", "libraryID 必须是正整数");
  }
  if (!Zotero.Libraries.get(id)) {
    throw new PlusError("LIBRARY_NOT_FOUND", "文库不存在");
  }
  return id;
}

export function requireKeys(
  value: unknown,
  name = "itemKeys",
  max = 500,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > max ||
    value.some((key) => typeof key !== "string" || !/^[A-Z0-9]{8}$/.test(key))
  ) {
    throw new PlusError(
      "INVALID_ARGUMENT",
      `${name} 必须是包含 1–${max} 个 Zotero key 的数组`,
    );
  }
  return [...new Set(value)];
}

export function requireWritable(libraryID: number, items: any[] = []): void {
  const library = Zotero.Libraries.get(libraryID);
  if (!library || !library.editable)
    throw new PlusError("READ_ONLY_LIBRARY", "目标文库不可编辑");
  for (const item of items) {
    if (item.libraryID !== libraryID)
      throw new PlusError("CROSS_LIBRARY", "不能跨文库修改条目");
    if (item.deleted || !item.isEditable()) {
      throw new PlusError("ITEM_NOT_EDITABLE", "条目不可编辑或已在回收站");
    }
  }
}

export function withoutConfirmation(args: JsonObject): JsonObject {
  const result = { ...args };
  delete result.dryRun;
  delete result.confirmationToken;
  delete result.idempotencyKey;
  return result;
}

export function assertDryRun(args: JsonObject): boolean {
  if (args.dryRun !== undefined && typeof args.dryRun !== "boolean") {
    throw new PlusError("INVALID_ARGUMENT", "dryRun 必须是布尔值");
  }
  return args.dryRun !== false;
}

export function publicError(error: unknown): {
  code: string;
  message: string;
  taskID?: string;
} {
  return error instanceof PlusError
    ? {
        code: error.code,
        message: error.message,
        ...(typeof error.details?.taskID === "string"
          ? { taskID: error.details.taskID }
          : {}),
      }
    : {
        code: "INTERNAL_ERROR",
        message: "操作失败；请检查本地诊断，不能据此认定没有发生写入",
      };
}
