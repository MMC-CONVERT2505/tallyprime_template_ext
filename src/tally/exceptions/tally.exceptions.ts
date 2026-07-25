import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Base for all Tally-side failures. We map these to 502/504 (the failure is in
 * an upstream dependency, not the caller's request) and always attach an
 * actionable hint, because 90% of real-world Tally issues are operational
 * (Tally closed, server mode off, wrong company name) rather than code bugs.
 */
export class TallyException extends HttpException {
  constructor(
    message: string,
    status: HttpStatus,
    public readonly hint?: string,
    // Named `originalCause` (not `cause`) to avoid clashing with the `cause`
    // field HttpException/Error already declares.
    public readonly originalCause?: unknown,
  ) {
    super({ message, hint, error: 'TallyError' }, status);
  }
}

/** Cannot reach Tally at all: ECONNREFUSED / EHOSTUNREACH / DNS failure. */
export class TallyUnreachableException extends TallyException {
  constructor(baseUrl: string, cause?: unknown) {
    super(
      `Could not reach Tally at ${baseUrl}.`,
      HttpStatus.BAD_GATEWAY,
      'Confirm TallyPrime is open with the target company loaded, and that ' +
        '"Act as Server" is enabled (F1 Help -> Settings -> Connectivity) on the configured port. ' +
        'A firewall or wrong TALLY_HOST/TALLY_PORT will also cause this.',
      cause,
    );
  }
}

/** Connected, but Tally did not answer within TALLY_TIMEOUT_MS. */
export class TallyTimeoutException extends TallyException {
  constructor(baseUrl: string, timeoutMs: number, cause?: unknown) {
    super(
      `Tally at ${baseUrl} did not respond within ${timeoutMs}ms.`,
      HttpStatus.GATEWAY_TIMEOUT,
      'Large companies or wide date ranges can exceed the timeout. Chunk the ' +
        'request by month, or raise TALLY_TIMEOUT_MS for one-off big pulls.',
      cause,
    );
  }
}

/** Reached Tally, but the HTTP layer returned a non-2xx status. */
export class TallyHttpException extends TallyException {
  constructor(baseUrl: string, statusCode: number, body?: string) {
    super(
      `Tally at ${baseUrl} returned HTTP ${statusCode}.`,
      HttpStatus.BAD_GATEWAY,
      'Tally normally answers 200 even for TDL errors, so a non-200 usually ' +
        'means the port is served by something other than Tally.',
      body,
    );
  }
}

/**
 * Reached Tally and got XML back, but the payload is a TDL/report error
 * (e.g. <LINEERROR>, "Could not find Report", "Unknown Request").
 */
export class TallyResponseException extends TallyException {
  constructor(message: string, cause?: unknown) {
    super(
      `Tally reported an error: ${message}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Check the report/collection name and that the company name matches ' +
        'EXACTLY (case, spacing, "&" vs "and") what Tally shows.',
      cause,
    );
  }
}
