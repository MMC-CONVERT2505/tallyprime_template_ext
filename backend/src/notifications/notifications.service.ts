import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { SmtpConfig } from '../config/configuration';

export interface ExtractionCompleteNotice {
  jobId: string;
  type: string;
  status: 'SUCCESS' | 'FAILED';
  recordCount?: number | null;
  error?: string | null;
}

/**
 * Best-effort email notifications — never blocks or fails a job over mail
 * delivery. Same graceful-degrade shape as PrismaService/Redis elsewhere:
 * if SMTP_HOST isn't set, every call is a debug-logged no-op rather than a
 * thrown error, so an unconfigured mail server never takes down extraction.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly transporter: nodemailer.Transporter | null;
  private readonly from: string;

  constructor(config: ConfigService) {
    const smtp = config.getOrThrow<SmtpConfig>('smtp');
    this.from = smtp.from;

    if (!smtp.host) {
      this.transporter = null;
      return;
    }

    this.transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    });
  }

  /**
   * Unlike sendExtractionComplete's silent debug-log no-op, an unconfigured
   * SMTP here still surfaces the code at `warn` level — this is the only way
   * a "forgot password" flow can be exercised at all in a local/dev
   * environment with no mail server (same "stay usable without the real
   * infra" idea as AgentPairingService printing its pairing code to the
   * console when unpaired). In practice this rarely matters outside
   * production anyway, since AuthService.generateOtp already hands out a
   * fixed, well-known code there — this path only fires for the one case
   * where it still can't be predicted (a real, random OTP with no SMTP
   * configured, e.g. a misconfigured staging box).
   */
  async sendPasswordResetOtp(to: string, otp: string): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(`SMTP not configured — password reset code for ${to}: ${otp}`);
      return;
    }

    const subject = 'Your password reset code';
    const body =
      `Your password reset code is: ${otp}\n\n` +
      `Enter it on the login screen to set a new password. It expires in 10 minutes.\n\n` +
      `If you didn't request this, you can safely ignore this email.`;

    try {
      await this.transporter.sendMail({ from: this.from, to, subject, text: body });
    } catch (err) {
      // Best-effort, like sendExtractionComplete — but unlike that one, a
      // failed send here means the user has NO other way to get the code, so
      // this is worth a warn, not a swallowed debug log.
      this.logger.warn(`Could not send password reset code to ${to}: ${String(err)}`);
    }
  }

  /**
   * A durable, findable copy of a connector's bearer token — sent any time
   * one is minted or rotated (manual Connections-tab create/rotate, or a
   * device-pairing flow completing). Exists because the token is otherwise
   * shown exactly once (browser UI) or printed only to a console that may
   * not be visible (headless/service install, closed terminal window) — the
   * exact gap that made a lost/never-seen token this project's single
   * biggest pairing support cost. Still best-effort, same as
   * sendExtractionComplete: a failed/unconfigured send never blocks minting
   * the token itself, since the token is already returned to the caller
   * through its normal channel regardless.
   */
  async sendConnectorToken(
    to: string,
    info: { label: string; defaultCompany?: string | null; token: string; connectionId: string },
  ): Promise<void> {
    if (!this.transporter) {
      // Unlike sendPasswordResetOtp, this is never the ONLY way to see the
      // token (it's always also returned to whoever/whatever just minted
      // it) — a quiet debug log, same tone as sendExtractionComplete.
      this.logger.debug(`SMTP not configured — skipping connector token email for ${to}.`);
      return;
    }

    const companyLine = info.defaultCompany ? ` for "${info.defaultCompany}"` : ' (not pinned to a company)';
    const subject = `Connector token — ${info.label}`;
    const body =
      `A connector token was just created/rotated${companyLine}.\n\n` +
      `  Label: ${info.label}\n` +
      `  Connection ID: ${info.connectionId}\n\n` +
      `Token (keep this private — it lets a connector authenticate as your organization):\n` +
      `${info.token}\n\n` +
      `Put it in the connector's AGENT_TOKEN (its .env file) and start it — it connects immediately, ` +
      `no pairing code needed.\n\n` +
      `Didn't expect this? Revoke it immediately from the Connections tab.`;

    try {
      await this.transporter.sendMail({ from: this.from, to, subject, text: body });
    } catch (err) {
      this.logger.warn(`Could not send connector token email to ${to}: ${String(err)}`);
    }
  }

  async sendExtractionComplete(to: string, notice: ExtractionCompleteNotice): Promise<void> {
    if (!this.transporter) {
      this.logger.debug(`SMTP not configured — skipping notification for job ${notice.jobId}.`);
      return;
    }

    const subject =
      notice.status === 'SUCCESS'
        ? `Extraction complete: ${notice.type} (${notice.recordCount ?? 0} records)`
        : `Extraction failed: ${notice.type}`;
    const body =
      notice.status === 'SUCCESS'
        ? `Your ${notice.type} extraction (job ${notice.jobId}) finished — ${notice.recordCount ?? 0} record(s).`
        : `Your ${notice.type} extraction (job ${notice.jobId}) failed: ${notice.error ?? 'unknown error'}`;

    try {
      await this.transporter.sendMail({ from: this.from, to, subject, text: body });
    } catch (err) {
      // Best-effort: the job itself already succeeded/failed and is recorded —
      // a failed notification email should never look like a failed extraction.
      this.logger.warn(`Could not send notification for job ${notice.jobId}: ${String(err)}`);
    }
  }
}
