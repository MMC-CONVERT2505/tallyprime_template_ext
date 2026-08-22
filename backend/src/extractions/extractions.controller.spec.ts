import { StreamableFile } from '@nestjs/common';
import { ExtractionsController } from './extractions.controller';

describe('ExtractionsController', () => {
  describe('GET :id/excel', () => {
    // Regression test for a live incident (2026-08-22): the handler used to
    // `return buffer;` under `@Res({ passthrough: true })`. Nest's Express
    // adapter only special-cases a Buffer/stream response when it's wrapped
    // in StreamableFile — a bare Buffer instead falls through to Express's
    // default res.json(), which silently JSON-serializes it (Buffer's own
    // toJSON() -> {type:"Buffer", data:[...]}) instead of sending raw bytes.
    // The Content-Type header still correctly claimed .xlsx, so this was
    // invisible to every existing test (all of which inspect the Buffer
    // in-memory, never through a real HTTP response) — only a genuine
    // download-and-reopen caught it: the .xlsx came back corrupt (unreadable
    // as a zip). This test pins the fix: the handler must hand back a
    // StreamableFile, never a bare Buffer, so Nest sends it untouched.
    it('wraps the Excel buffer in a StreamableFile instead of returning a bare Buffer', async () => {
      const buffer = Buffer.from('PK-fake-xlsx-bytes');
      const extractions = {
        getExcelResult: jest.fn().mockResolvedValue({ buffer, filename: 'bills-job-1.xlsx' }),
      };
      const bulkExport = {};
      const controller = new ExtractionsController(extractions as any, bulkExport as any);
      const res = { set: jest.fn() };
      const user = { sub: 'user-1', email: 'u@example.com', orgId: 'org-1' };

      const result = await controller.excel(
        user,
        'job-1',
        undefined,
        undefined,
        undefined,
        res as any,
      );

      expect(result).toBeInstanceOf(StreamableFile);
      // StreamableFile buffers the underlying source in a private field, but
      // getStream()/what it wraps must be exactly the bytes returned by
      // getExcelResult — not a JSON-stringified re-encoding of them.
      const streamed = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = result.getStream();
        stream.on('data', (chunk) => chunks.push(chunk as Buffer));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
      expect(streamed).toEqual(buffer);

      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="bills-job-1.xlsx"',
        }),
      );
    });

    it('rejects an invalid ledgerEntity before ever calling the service', async () => {
      const extractions = { getExcelResult: jest.fn() };
      const controller = new ExtractionsController(extractions as any, {} as any);
      const user = { sub: 'user-1', email: 'u@example.com', orgId: 'org-1' };

      await expect(
        controller.excel(user, 'job-1', undefined, 'NOT_A_REAL_ENTITY', undefined, {
          set: jest.fn(),
        } as any),
      ).rejects.toThrow('ledgerEntity must be one of COA, CUSTOMER, VENDOR.');
      expect(extractions.getExcelResult).not.toHaveBeenCalled();
    });
  });
});
