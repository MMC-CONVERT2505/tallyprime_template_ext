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
