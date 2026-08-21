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

/** Connected, but Tally did not answer within the applicable timeout (TALLY_TIMEOUT_MS for
 *  real extraction calls, the much shorter TALLY_PROBE_TIMEOUT_MS for /tally/probe and
 *  /health/tally — this exception covers both, so the hint names whichever applies). */
export class TallyTimeoutException extends TallyException {
  constructor(baseUrl: string, timeoutMs: number, cause?: unknown) {
    super(
      `Tally at ${baseUrl} did not respond within ${timeoutMs}ms.`,
      HttpStatus.GATEWAY_TIMEOUT,
      'If this is a real extraction, large companies or wide date ranges can exceed the ' +
        'timeout — chunk the request by month, or raise TALLY_TIMEOUT_MS for one-off big pulls. ' +
        'If this is a probe/health check, Tally itself is likely slow to respond or hung — check ' +
        "it's actually running and responsive, not just that its window is open " +
        '(raising TALLY_PROBE_TIMEOUT_MS only masks a slow Tally, it will not fix a hung one).',
      cause,
    );
  }
}

/**
 * Fails fast, before even attempting the network call, once enough recent
 * requests have already timed out/failed that Tally is very likely
 * completely wedged — not just one flaky call. See TallyHttpClient's
 * circuit breaker. Without this, every retry (both TallyHttpClient's own and
 * the outer BullMQ job-level retry) independently rediscovers the same hang
 * by waiting out a full TALLY_TIMEOUT_MS, turning one stuck Tally into
 * minutes of serial 60s+ waits before anything finally reports failure.
 */
export class TallyCircuitOpenException extends TallyException {
  constructor(baseUrl: string, recentFailures: number, retryAfterMs: number) {
    super(
      `Tally at ${baseUrl} appears unresponsive (${recentFailures} consecutive requests failed) ` +
        '— not retrying yet.',
      HttpStatus.SERVICE_UNAVAILABLE,
      'Tally is very likely wedged, not just slow: check the TallyPrime window for a blocking ' +
        'dialog (a security/password prompt, license reminder, unsaved report, "Quit?" ' +
        'confirmation) and dismiss it, or restart TallyPrime if nothing is visible. Requests will ' +
        `resume automatically in about ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`,
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
