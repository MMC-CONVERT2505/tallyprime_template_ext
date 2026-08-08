import { resolve } from 'path';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { upsertEnvValue } from './env-file.util';

interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

type DevicePollResponse =
  { status: 'pending' } | { status: 'approved'; id: string; label: string; token: string };

/**
 * Automatic device-flow pairing (RFC 8628-style — see the DeviceAuthorization
 * Prisma model's doc comment on the backend for the full design). This is
 * what replaces "a human copies a token into .env": on first boot with no
 * AGENT_TOKEN configured, AgentTunnelClient calls `pair()` instead of
 * connecting directly, which:
 *   1. asks the backend for a device code + a short human-typeable user code,
 *   2. prints the user code so whoever is installing this can approve it
 *      (the one unavoidable human trust decision in the whole flow),
 *   3. polls until approved, then persists the real token into this
 *      machine's own .env so future restarts skip pairing entirely.
 */
@Injectable()
export class AgentPairingService {
  private readonly logger = new Logger(AgentPairingService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async pair(): Promise<string> {
    const apiBaseUrl = this.config.get<string>('apiBaseUrl')!;
    const start = await firstValueFrom(
      this.http.post<DeviceStartResponse>(`${apiBaseUrl}/connections/device/start`, {}),
    );
    const { deviceCode, userCode, expiresIn, interval } = start.data;

    this.logger.warn(
      `\n` +
        `================================================================\n` +
        `  This connector is not yet paired to an organization.\n` +
        `  1. Sign in to the web app.\n` +
        `  2. Approve this device with code:  ${userCode}\n` +
        `     (POST ${apiBaseUrl}/connections/device/approve\n` +
        `      { "userCode": "${userCode}", "defaultCompany": "<exact Tally company>" }\n` +
        `      while signed in)\n` +
        `  Waiting up to ${Math.round(expiresIn / 60)} minute(s) for approval...\n` +
        `================================================================\n`,
    );

    const deadline = Date.now() + expiresIn * 1000;
    while (Date.now() < deadline) {
      await this.sleep(interval * 1000);

      const poll = await firstValueFrom(
        this.http.post<DevicePollResponse>(
          `${apiBaseUrl}/connections/device/token`,
          { deviceCode },
          { validateStatus: () => true },
        ),
      );

      if (poll.status >= 400) {
        const message = (poll.data as { message?: string })?.message ?? `HTTP ${poll.status}`;
        throw new Error(`Pairing failed: ${message}`);
      }
      if (poll.data.status === 'approved') {
        this.logger.log(
          `Paired successfully — connection id ${poll.data.id} ("${poll.data.label}").`,
        );
        this.persistToken(poll.data.token);
        return poll.data.token;
      }
      // status === 'pending' — keep polling.
    }

    throw new Error(
      `Pairing timed out after ${Math.round(expiresIn / 60)} minute(s) without approval — restart the connector to try again.`,
    );
  }

  /** Writes AGENT_TOKEN into this process's own .env so the next restart skips pairing entirely. */
  private persistToken(token: string): void {
    const envPath = resolve(process.cwd(), '.env');
    try {
      upsertEnvValue(envPath, 'AGENT_TOKEN', token);
      this.logger.log(`Saved AGENT_TOKEN to ${envPath} for future restarts.`);
    } catch (err) {
      // Non-fatal: this run still has the token in memory and will connect
      // fine. Only a future restart would need to re-pair.
      this.logger.warn(
        `Could not persist AGENT_TOKEN to ${envPath} (this run is unaffected, but the ` +
          `next restart will need to re-pair): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
