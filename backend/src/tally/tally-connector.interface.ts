/**
 * The connector boundary between extraction logic and Tally's transport.
 *
 * Tally's XML/HTTP interface is stateless request/response — there is no
 * session to open or hold — so this is deliberately just "send an envelope,
 * get XML back," not a connect()/authenticate()/disconnect() lifecycle that
 * would model a session Tally doesn't actually have. `TallyHttpClient`
 * implements this (used both by the cloud app talking to Tally directly, and
 * by the connector/agent process talking to its local Tally over the tunnel).
 *
 * Extraction services depend on this interface (via the TALLY_CONNECTOR
 * token), not on TallyHttpClient directly, so the transport can be swapped —
 * a test double, or a future alternate connector — without touching
 * extraction logic.
 */
export interface TallyPostOptions {
  /** Overrides TallyConfig.timeoutMs for this call only (e.g. a fast probe). */
  timeoutMs?: number;
  /** Overrides TallyConfig.maxRetries for this call only. 0 disables retrying. */
  retries?: number;
}

export interface TallyConnector {
  /** Sends a request envelope to Tally and returns its raw (decoded) XML response. */
  post(envelopeXml: string, opts?: TallyPostOptions): Promise<string>;
}

export const TALLY_CONNECTOR = Symbol('TALLY_CONNECTOR');
