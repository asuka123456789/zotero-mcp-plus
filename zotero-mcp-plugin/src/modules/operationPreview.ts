import {
  PlusError,
  assertDryRun,
  fingerprint,
  secureID,
  withoutConfirmation,
  type JsonObject,
  type OperationAdapter,
} from "./plusTypes.ts";
import { TaskStore } from "./taskStore.ts";

export class OperationPreview {
  private store: TaskStore;
  private canWrite: () => boolean;
  constructor(store: TaskStore, canWrite: () => boolean) {
    this.store = store;
    this.canWrite = canWrite;
  }

  async dispatch(
    adapter: OperationAdapter,
    args: JsonObject,
  ): Promise<JsonObject> {
    const dryRun = assertDryRun(args);
    const params = withoutConfirmation(args);
    const requestHash = await fingerprint({ tool: adapter.tool, params });
    if (!dryRun) {
      if (
        typeof args.idempotencyKey !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(args.idempotencyKey)
      ) {
        throw new PlusError(
          "INVALID_ARGUMENT",
          "执行必须提供 1–128 位的 idempotencyKey",
        );
      }
      // 已提交请求的响应可能丢失；其 token 过期不影响读取原任务。
      const existing = await this.store.existingRequest(
        args.idempotencyKey,
        requestHash,
      );
      if (existing) return { success: true, taskID: existing, replayed: true };
      if (!this.canWrite())
        throw new PlusError(
          "WRITE_DISABLED",
          "文库写入已关闭，仍可预览和查看任务",
        );
      if (
        typeof args.confirmationToken !== "string" ||
        args.confirmationToken.length > 256
      ) {
        throw new PlusError(
          "CONFIRMATION_REQUIRED",
          "先展示 dry-run 结果并取得用户确认，再提交确认令牌",
        );
      }
      const accepted = await this.store.enqueue(
        await fingerprint(args.confirmationToken),
        requestHash,
        args.idempotencyKey,
      );
      return {
        success: true,
        ...accepted,
        ...(!accepted.replayed ? { state: "queued" } : {}),
      };
    }
    const plan = await adapter.prepare(params);
    if (plan.tool !== adapter.tool || plan.schemaVersion !== 1) {
      throw new PlusError("INVALID_PLAN", "预览计划与工具不匹配");
    }
    const eligible = plan.steps.filter(
      (step) => !step.skipReason && !step.blockers?.length,
    );
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const token = eligible.length ? secureID("confirm") : undefined;
    if (token)
      await this.store.savePreview(
        await fingerprint(token),
        requestHash,
        plan,
        expiresAt,
      );
    return {
      success: true,
      dryRun: true,
      tool: adapter.tool,
      libraryID: plan.libraryID,
      total: plan.steps.length,
      eligible: eligible.length,
      skipped: plan.steps.filter((step) => step.skipReason).length,
      blocked: plan.steps.filter((step) => step.blockers?.length).length,
      items: plan.steps.map((step) => ({
        id: step.id,
        ...step.preview,
        skipReason: step.skipReason,
        blockers: step.blockers,
      })),
      warnings: plan.warnings,
      confirmationToken: token,
      expiresAt: token ? expiresAt : undefined,
      requiresUserConfirmation: Boolean(token),
      writeEnabled: this.canWrite(),
    };
  }
}
