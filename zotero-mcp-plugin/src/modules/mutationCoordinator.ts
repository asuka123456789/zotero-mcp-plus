import { runSerializedWrite } from "./deferredNotifierCommitter.ts";
import type { OperationAdapter } from "./plusTypes.ts";

export class MutationCoordinator {
  async run<T>(
    adapter: OperationAdapter,
    operation: () => Promise<T>,
  ): Promise<T> {
    // 识别与 translator 的网络等待不占用普通短写入队列。
    return adapter.lane === "mutation"
      ? runSerializedWrite(operation)
      : operation();
  }
}
