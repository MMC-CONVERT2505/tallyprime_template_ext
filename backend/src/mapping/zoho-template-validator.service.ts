import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ExcelGeneratorService } from '../excel/excel-generator.service';
import { ZOHO_ENTITIES, templatePathFor } from './zoho-entity.map';

/**
 * Fails loudly at boot if a registered Zoho template file/sheet is missing or
 * renamed, instead of the first user export request hitting a confusing
 * "no sheet named X" error deep inside a queued job.
 */
@Injectable()
export class ZohoTemplateValidatorService implements OnModuleInit {
  private readonly logger = new Logger(ZohoTemplateValidatorService.name);

  constructor(private readonly excel: ExcelGeneratorService) {}

  async onModuleInit(): Promise<void> {
    const entries = Object.entries(ZOHO_ENTITIES) as [
      keyof typeof ZOHO_ENTITIES,
      (typeof ZOHO_ENTITIES)[keyof typeof ZOHO_ENTITIES],
    ][];

    const failures: string[] = [];
    for (const [key, def] of entries) {
      try {
        await this.excel.assertTemplateReadable(templatePathFor(key), def.sheetName);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${key}: ${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Zoho export templates are missing or invalid:\n${failures.join('\n')}`);
    }
    this.logger.log(`Verified ${entries.length} Zoho export template(s).`);
  }
}
