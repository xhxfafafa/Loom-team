/**
 * Workspace / Delivery - /workspace/:workspaceId/delivery
 * Final Delivery View — read-only delivery overview.
 */
import { DeliveryPageClient } from "./delivery-page-client";

export async function generateStaticParams() {
  if (process.env.ROUTA_BUILD_STATIC === "1") {
    return [{ workspaceId: "__placeholder__" }];
  }
  return [];
}

export default function WorkspaceDeliveryPage() {
  return <DeliveryPageClient />;
}
