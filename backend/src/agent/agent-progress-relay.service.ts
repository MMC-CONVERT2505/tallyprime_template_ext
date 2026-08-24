import { Injectable } from '@nestjs/common';

export type AgentProgressSender = (
  requestId: string,
  progress: string,
  recordsSoFar?: number,
) => void;

/**
 * Decouples the extraction services' `EXTRACTION_JOB_REPOSITORY`-shaped
 * progress writes (TallyExtractionServiceBase.reportProgress, unchanged code
 * shared with the cloud backend) from AgentTunnelClient, which owns the
 * actual WebSocket. AgentTunnelClient registers itself as the sender once at
 * construction; AgentModule's EXTRACTION_JOB_REPOSITORY stub calls `report()`
 * on every batch/chunk instead of the Postgres write the same call performs
 * on the cloud backend — this process has no Postgres of its own, by design
 * (see AgentModule's doc comment).
 */
@Injectable()
export class AgentProgressRelay {
  private sender: AgentProgressSender | null = null;

  setSender(sender: AgentProgressSender): void {
    this.sender = sender;
  }

  report(requestId: string, progress: string, recordsSoFar?: number): void {
    this.sender?.(requestId, progress, recordsSoFar);
  }
}
