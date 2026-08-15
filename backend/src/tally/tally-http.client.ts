import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosResponse } from 'axios';
import * as iconv from 'iconv-lite';
import { firstValueFrom } from 'rxjs';
import { TallyConfig } from '../config/configuration';
import { TallyConnector, TallyPostOptions } from './tally-connector.interface';
import {
  TallyHttpException,
  TallyTimeoutException,
  TallyUnreachableException,
} from './exceptions/tally.exceptions';

/**
 * The ONLY place that speaks HTTP to Tally. Responsibilities:
 *   - POST the XML envelope to Tally's port-9001 server.
 *   - Decode the response with the correct charset (Tally is not reliably UTF-8).
 *   - Translate low-level socket/HTTP failures into typed, actionable exceptions.
 *   - Retry transient failures (timeout/unreachable) with exponential backoff —
 *     safe because every request this app now sends is a read (Tally's
 *     "Export"/report requests); there is no write/import path left to
 *     accidentally double-apply on a retry.
 *
 * We fetch the body as raw bytes (arraybuffer) rather than letting axios decode
 * to a string, because TallyPrime often replies in windows-1252 / ISO-8859-1
 * without a correct charset header — decoding as UTF-8 then mangles £, é, ½, etc.
 */
@Injectable()
export class TallyHttpClient implements TallyConnector {
  private readonly logger = new Logger(TallyHttpClient.name);

  /**
   * Serializes every request through this client — Tally's HTTP export
   * handling is effectively single-threaded, so two overlapping requests
   * (an extraction mid-flight plus a probe, or two jobs at once) is an
   * independent contributor to Tally hanging, on top of any single request
   * being too large (see MasterExtractionService's batching). This queue
   * ensures request N+1 only ever starts after request N's response (or
   * final failure) lands, app-wide — no config knob, unconditionally correct
   * given Tally's own nature. `.catch(() => undefined)` on the queue link
   * only prevents one request's failure from poisoning the chain for
   * whatever queues behind it; the real error still propagates to *this*
   * call's own caller via `run` below.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private get tally(): TallyConfig {
    return this.config.getOrThrow<TallyConfig>('tally');
  }

  /**
   * Send an XML envelope to Tally and return the decoded XML string. Queued
   * behind any in-flight request (see `queue` above), then retries transient
   * failures (timeout/unreachable) with exponential backoff — NOT a non-2xx
   * response from Tally itself (TallyHttpException), since that's a
   * definitive answer, not a dropped connection, and retrying it wouldn't
   * change the outcome.
   * @throws TallyUnreachableException | TallyTimeoutException | TallyHttpException
   */
  post(xml: string, opts?: TallyPostOptions): Promise<string> {
    const run = this.queue.then(() => this.postWithRetry(xml, opts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async postWithRetry(xml: string, opts?: TallyPostOptions): Promise<string> {
    const { retryBaseMs } = this.tally;
    const maxRetries = opts?.retries ?? this.tally.maxRetries;
    const timeoutMs = opts?.timeoutMs ?? this.tally.timeoutMs;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.postOnce(xml, timeoutMs);
      } catch (err) {
        const transient =
          err instanceof TallyTimeoutException || err instanceof TallyUnreachableException;
        if (!transient || attempt >= maxRetries) throw err;

        const delayMs = retryBaseMs * 2 ** attempt;
        this.logger.warn(
          `Tally request failed (${(err as Error).message}) — retrying in ${delayMs}ms ` +
            `(attempt ${attempt + 2}/${maxRetries + 1})`,
        );
        await this.sleep(delayMs);
      }
    }
  }

  private async postOnce(xml: string, timeoutMs: number): Promise<string> {
    const { baseUrl } = this.tally;
    const startedAt = Date.now();

    try {
      const response = await firstValueFrom(
        this.http.post<ArrayBuffer>(baseUrl, xml, {
          responseType: 'arraybuffer',
          timeout: timeoutMs,
          // Tally does not use HTTP status codes to signal TDL errors, and can be
          // fussy about headers. text/xml is the broadly-accepted content type.
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            Accept: 'text/xml, application/xml',
          },
          // We validate status ourselves so we can attach Tally-specific hints.
          validateStatus: () => true,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }),
      );

      if (response.status < 200 || response.status >= 300) {
        const preview = this.decode(response, response.data).slice(0, 500);
        throw new TallyHttpException(baseUrl, response.status, preview);
      }

      const body = this.decode(response, response.data);
      this.logger.debug(
        `Tally responded ${response.status} in ${Date.now() - startedAt}ms (${body.length} chars)`,
      );
      return body;
    } catch (err) {
      if (err instanceof TallyHttpException) throw err;
      throw this.translateError(err, baseUrl, timeoutMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Decode the response bytes to a string using, in order of preference:
   *   1. an explicit TALLY_RESPONSE_ENCODING override,
   *   2. the charset declared in the Content-Type header,
   *   3. utf-8.
   */
  private decode(response: AxiosResponse, data: ArrayBuffer | Buffer): string {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const override = this.tally.responseEncoding;

    let encoding = 'utf-8';
    if (override && override !== 'auto') {
      encoding = this.normalizeEncoding(override);
    } else {
      const contentType = String(response.headers?.['content-type'] ?? '');
      const match = contentType.match(/charset=([^;]+)/i);
      encoding = match ? this.normalizeEncoding(match[1].trim()) : 'utf-8';
    }

    if (!iconv.encodingExists(encoding)) {
      this.logger.warn(`Unknown response encoding "${encoding}", falling back to utf-8`);
      encoding = 'utf-8';
    }
    return iconv.decode(buffer, encoding);
  }

  private normalizeEncoding(enc: string): string {
    const e = enc.toLowerCase();
    if (e === 'win1252') return 'windows-1252';
    if (e === 'utf8') return 'utf-8';
    return e;
  }

  private translateError(err: unknown, baseUrl: string, timeoutMs: number): Error {
    const axiosErr = err as AxiosError;
    const code = axiosErr?.code;

    // Timeouts: axios raises ECONNABORTED (or ETIMEDOUT on some platforms).
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      this.logger.error(`Tally request timed out after ${timeoutMs}ms`);
      return new TallyTimeoutException(baseUrl, timeoutMs, err);
    }

    // Not reachable: server closed, wrong host/port, DNS, network down.
    if (
      code === 'ECONNREFUSED' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH' ||
      code === 'ENOTFOUND' ||
      code === 'ECONNRESET' ||
      code === 'EAI_AGAIN'
    ) {
      this.logger.error(`Tally unreachable at ${baseUrl}: ${code}`);
      return new TallyUnreachableException(baseUrl, err);
    }

    this.logger.error(`Unexpected error talking to Tally: ${axiosErr?.message ?? String(err)}`);
    // Unknown transport failure — treat as unreachable (safer default than 500).
    return new TallyUnreachableException(baseUrl, err);
  }
}
