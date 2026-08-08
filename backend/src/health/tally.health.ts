import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { TallyDiagnosticsService } from '../tally/tally-diagnostics.service';

/**
 * Reports Tally reachability. Note: this is intentionally SEPARATED from the
 * core /health liveness check — a client's Tally being closed is a normal,
 * expected state and must not make the whole service report unhealthy (which
 * would, for instance, cause an orchestrator to kill the pod).
 */
@Injectable()
export class TallyHealthIndicator {
  constructor(
    private readonly tally: TallyDiagnosticsService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      const probe = await this.tally.probe();
      return indicator.up({
        companies: probe.companies.length,
        durationMs: probe.durationMs,
      });
    } catch (err) {
      return indicator.down({
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
