import { Injectable } from '@nestjs/common';
import archiver from 'archiver';
import { PassThrough } from 'stream';

export interface ZipEntry {
  /** Filename inside the archive, e.g. "COA.xlsx" — never a full path. */
  filename: string;
  buffer: Buffer;
}

/**
 * Bundles several already-generated files (typically Excel exports from
 * ExcelGeneratorService) into a single downloadable .zip Buffer. Deliberately
 * knows nothing about Tally/Zoho/Excel — see excel-generator.service.ts's
 * matching doc comment on keeping layers single-purpose.
 */
@Injectable()
export class ZipService {
  /**
   * `zlib` level 9 (max compression, archiver's own default) — these are
   * small spreadsheets, not media, so the CPU cost is negligible and every
   * export benefits from the smaller download.
   */
  async buildZip(entries: ZipEntry[]): Promise<Buffer> {
    if (entries.length === 0) {
      throw new Error('Cannot build a zip with zero entries.');
    }

    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));

    const done = new Promise<Buffer>((resolve, reject) => {
      output.on('end', () => resolve(Buffer.concat(chunks)));
      output.on('error', reject);
      archive.on('error', reject);
    });

    archive.pipe(output);
    for (const entry of entries) {
      archive.append(entry.buffer, { name: entry.filename });
    }
    await archive.finalize();

    return done;
  }
}
