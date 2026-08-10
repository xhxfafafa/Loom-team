import type { SessionUpdateNotification } from "@/core/acp/http-session-store";
import { saveHistoryToDb } from "@/core/acp/session-db-persister";
import { SessionWriteBuffer } from "@/core/acp/session-write-buffer";

let writeBuffer: SessionWriteBuffer | null = null;

export function getSessionWriteBuffer(): SessionWriteBuffer {
  if (!writeBuffer) {
    writeBuffer = new SessionWriteBuffer({
      persistFn: saveHistoryToDb,
    });
  }
  return writeBuffer;
}

/** Minimal store surface needed to snapshot consolidated session history. */
export interface HistorySnapshotStore {
  getConsolidatedHistory(sessionId: string): SessionUpdateNotification[];
}

export function persistSessionHistorySnapshot(
  sessionId: string,
  store: HistorySnapshotStore,
): Promise<void> {
  const buffer = getSessionWriteBuffer();
  buffer.replace(sessionId, store.getConsolidatedHistory(sessionId));
  return buffer.flush(sessionId);
}
