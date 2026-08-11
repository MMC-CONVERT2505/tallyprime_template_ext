import { TallyDiagnosticsService } from './tally-diagnostics.service';
import { EnvelopeBuilder } from './xml/envelope.builder';
import { TallyResponseParser } from './xml/response.parser';

describe('TallyDiagnosticsService', () => {
  function makeService(
    overrides: { connectorPost?: jest.Mock; defaultCompany?: string; probeTimeoutMs?: number } = {},
  ) {
    const builder = new EnvelopeBuilder();
    const connector = {
      post: overrides.connectorPost ?? jest.fn().mockResolvedValue('<ENVELOPE></ENVELOPE>'),
    };
    const parser = new TallyResponseParser();
    const config = {
      getOrThrow: () => ({
        defaultCompany: overrides.defaultCompany ?? '',
        probeTimeoutMs: overrides.probeTimeoutMs ?? 8000,
      }),
    };

    const service = new TallyDiagnosticsService(
      builder,
      connector as any,
      parser,
      config as any,
      undefined,
      undefined,
    );
    return { service, connector };
  }

  describe('probe', () => {
    it('reports reachable with the discovered companies and round-trip duration', async () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION><COMPANY><NAME>ABC Ltd</NAME></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>';
      const { service } = makeService({ connectorPost: jest.fn().mockResolvedValue(xml) });

      const result = await service.probe();

      expect(result.reachable).toBe(true);
      expect(result.companies).toEqual(['ABC Ltd']);
      expect(typeof result.durationMs).toBe('number');
    });

    it('propagates a connector failure rather than swallowing it', async () => {
      const { service } = makeService({
        connectorPost: jest.fn().mockRejectedValue(new Error('unreachable')),
      });

      await expect(service.probe()).rejects.toThrow('unreachable');
    });

    it('uses the short probeTimeoutMs with retries disabled, not the full extraction timeout/retry pipeline', async () => {
      const connectorPost = jest.fn().mockResolvedValue('<ENVELOPE></ENVELOPE>');
      const { service } = makeService({ connectorPost, probeTimeoutMs: 4321 });

      await service.probe();

      expect(connectorPost).toHaveBeenCalledWith(expect.any(String), {
        timeoutMs: 4321,
        retries: 0,
      });
    });
  });

  describe('getRaw', () => {
    it('resolves the company (falling back to the configured default) and returns the raw XML', async () => {
      const xml = '<ENVELOPE><BODY><DATA>ok</DATA></BODY></ENVELOPE>';
      const { service, connector } = makeService({
        connectorPost: jest.fn().mockResolvedValue(xml),
        defaultCompany: 'Default Co',
      });

      const result = await service.getRaw({ reportName: 'Trial Balance' });

      expect(result.company).toBe('Default Co');
      expect(result.rawXml).toBe(xml);
      expect(connector.post).toHaveBeenCalledTimes(1);
    });

    it('surfaces a Tally-side error (e.g. unknown report) rather than returning it as data', async () => {
      const xml =
        '<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER><BODY><DESC><LINEERROR>Could not find Report</LINEERROR></DESC></BODY></ENVELOPE>';
      const { service } = makeService({ connectorPost: jest.fn().mockResolvedValue(xml) });

      await expect(service.getRaw({ reportName: 'Nonexistent' })).rejects.toThrow(
        /Could not find Report/,
      );
    });
  });
});
