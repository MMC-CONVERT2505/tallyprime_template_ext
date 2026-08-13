import { ExtractableType } from './extraction-action.map';

/**
 * The BullMQ job payload — deliberately small; the ExtractionJob Postgres row
 * (keyed by extractionJobId) is the durable source of truth for status.
 *
 * Two dispatch modes, discriminated by `mode`:
 *   - 'agent': the org-scoped, connector-mediated path (POST /extractions,
 *     POST /extractions/fetch-master) — routed to a specific paired agent
 *     over the WebSocket tunnel via TallyTunnelGateway.sendCommand.
 *   - 'local': the unauthenticated dev/testing path (POST /tally/jobs) —
 *     dispatched directly against the backend's own configured Tally
 *     (TALLY_HOST/TALLY_PORT), no agent/connection involved at all. Exists
 *     so "Tally Direct" gets the same queue/poll/fetch treatment as the
 *     agent path instead of blocking the HTTP request for however long a
 *     slow Tally call takes.
 */
export type ExtractionJobData =
  | {
      mode: 'agent';
      extractionJobId: string;
      connectionId: string;
      type: ExtractableType;
      payload: Record<string, unknown>;
      notifyEmail: string;
    }
  | {
      mode: 'local';
      extractionJobId: string;
      type: ExtractableType;
      payload: Record<string, unknown>;
    };
