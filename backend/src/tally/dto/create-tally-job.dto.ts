import { IsIn, IsObject, IsOptional } from 'class-validator';
import { EXTRACTABLE_TYPES, ExtractableType } from '../../extractions/extraction-action.map';

/**
 * POST /tally/jobs — the async counterpart of the direct GET /tally/*
 * endpoints. No connectionId (unlike CreateExtractionDto): this dispatches
 * straight to the backend's own configured Tally, no paired connector
 * involved, matching the existing unauthenticated /tally/* routes' scope.
 */
export class CreateTallyJobDto {
  @IsIn(EXTRACTABLE_TYPES)
  type!: ExtractableType;

  /**
   * Passed through to the corresponding extraction service method (e.g.
   * { company, fromDate, toDate } for LEDGERS). Not validated per-type here —
   * a missing required field surfaces as a FAILED job with a clear error
   * message from the service's own validation, same as the synchronous
   * /tally/* endpoints today.
   */
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
