import type { TenantId, UserId, RequestId } from "@crossengin/types";

export const KERNEL_VERSION = "0.0.0";

export interface KernelContext {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly requestId: RequestId;
}
