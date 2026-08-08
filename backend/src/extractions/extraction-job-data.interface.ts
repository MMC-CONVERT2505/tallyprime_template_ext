import { ExtractableType } from './extraction-action.map';

/** The BullMQ job payload — deliberately small; the ExtractionJob Postgres row
 *  (keyed by extractionJobId) is the durable source of truth for status. */
export interface ExtractionJobData {
  extractionJobId: string;
  connectionId: string;
  type: ExtractableType;
  payload: Record<string, unknown>;
  notifyEmail: string;
}
