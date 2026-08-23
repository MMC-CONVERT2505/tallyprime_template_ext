import { IsArray, IsIn, IsOptional } from 'class-validator';
import { BULK_EXPORT_STEP_KEYS, BulkExportStepKey } from '../bulk-export.service';

/**
 * Body for POST /extractions/bulk-export/:id/retry. `steps` is optional and
 * NEVER trusted blindly: BulkExportService.retry always computes the real
 * retryable set itself (FAILED, plus PENDING left over from a run that
 * predates this feature — see that method's doc comment) and intersects it
 * with whatever's supplied here. Omitting `steps` entirely — the shape the
 * frontend's "Retry Failed Functions" button actually sends — retries
 * everything currently retryable.
 */
export class BulkExportRetryDto {
  @IsOptional()
  @IsArray()
  @IsIn(BULK_EXPORT_STEP_KEYS, { each: true })
  steps?: BulkExportStepKey[];
}
