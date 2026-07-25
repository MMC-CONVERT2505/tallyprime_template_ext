import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosResponse } from 'axios';
import * as iconv from 'iconv-lite';
import { firstValueFrom } from 'rxjs';
import { TallyConfig } from '../config/configuration';
import {
  TallyHttpException,
  TallyTimeoutException,
  TallyUnreachableException,
} from './exceptions/tally.exceptions';

/**
 * The ONLY place that speaks HTTP to Tally. Responsibilities:
 *   - POST the XML envelope to Tally's port-9000 server.
 *   - Decode the response with the correct charset (Tally is not reliably UTF-8).
 *   - Translate low-level socket/HTTP failures into typed, actionable exceptions.
 *
 * We fetch the body as raw bytes (arraybuffer) rather than letting axios decode
 * to a string, because TallyPrime often replies in windows-1252 / ISO-8859-1
 * without a correct charset header — decoding as UTF-8 then mangles £, é, ½, etc.
 */
@Injectable()
export class TallyHttpClient {
  private readonly logger = new Logger(TallyHttpClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private get tally(): TallyConfig {
    return this.config.getOrThrow<TallyConfig>('tally');
  }

  /**
   * Send an XML envelope to Tally and return the decoded XML string.
   * @throws TallyUnreachableException | TallyTimeoutException | TallyHttpException
   */
  async post(xml: string): Promise<string> {
    const { baseUrl, timeoutMs } = this.tally;
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
