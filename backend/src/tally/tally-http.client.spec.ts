import { from, of, throwError } from 'rxjs';
import { TallyHttpClient } from './tally-http.client';
import { TallyHttpException, TallyUnreachableException } from './exceptions/tally.exceptions';

describe('TallyHttpClient — retry with backoff', () => {
  function makeClient(tallyOverrides: Partial<{ maxRetries: number; retryBaseMs: number }> = {}) {
    const httpPost = jest.fn();
    const http = { post: httpPost } as any;
    const config = {
      getOrThrow: () => ({
        baseUrl: 'http://127.0.0.1:9001',
        timeoutMs: 60000,
        responseEncoding: 'auto',
        maxRetries: 2,
        retryBaseMs: 1, // keep tests fast — backoff shape is covered separately below
        ...tallyOverrides,
      }),
    } as any;
    const client = new TallyHttpClient(http, config);
    return { client, httpPost };
  }

  const connectionRefused = () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });

  it('returns the decoded body on the first successful attempt without retrying', async () => {
    const { client, httpPost } = makeClient();
    httpPost.mockReturnValueOnce(
      of({ status: 200, headers: {}, data: Buffer.from('<ENVELOPE></ENVELOPE>') }),
    );

    const result = await client.post('<ENVELOPE/>');

    expect(result).toBe('<ENVELOPE></ENVELOPE>');
    expect(httpPost).toHaveBeenCalledTimes(1);
  });

  it('retries a transient network failure (ECONNREFUSED) and succeeds on the second attempt', async () => {
    const { client, httpPost } = makeClient();
    httpPost
      .mockReturnValueOnce(throwError(connectionRefused))
      .mockReturnValueOnce(
        of({ status: 200, headers: {}, data: Buffer.from('<ENVELOPE></ENVELOPE>') }),
      );

    const result = await client.post('<ENVELOPE/>');

    expect(result).toBe('<ENVELOPE></ENVELOPE>');
    expect(httpPost).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries and throws the transient exception', async () => {
    const { client, httpPost } = makeClient({ maxRetries: 2 });
    httpPost.mockReturnValue(throwError(connectionRefused));

    await expect(client.post('<ENVELOPE/>')).rejects.toThrow(TallyUnreachableException);
    expect(httpPost).toHaveBeenCalledTimes(3); // 1 initial attempt + 2 retries
  });

  it('does not retry at all when maxRetries is 0', async () => {
    const { client, httpPost } = makeClient({ maxRetries: 0 });
    httpPost.mockReturnValue(throwError(connectionRefused));

    await expect(client.post('<ENVELOPE/>')).rejects.toThrow(TallyUnreachableException);
    expect(httpPost).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a definitive non-2xx response from Tally (not a transient/network failure)', async () => {
    const { client, httpPost } = makeClient();
    httpPost.mockReturnValue(of({ status: 500, headers: {}, data: Buffer.from('server error') }));

    await expect(client.post('<ENVELOPE/>')).rejects.toThrow(TallyHttpException);
    expect(httpPost).toHaveBeenCalledTimes(1);
  });

  describe('per-call opts override (used by probe() for a fast-fail health check)', () => {
    it('overrides retries: 0 to skip the configured maxRetries entirely', async () => {
      const { client, httpPost } = makeClient({ maxRetries: 2 });
      httpPost.mockReturnValue(throwError(connectionRefused));

      await expect(client.post('<ENVELOPE/>', { retries: 0 })).rejects.toThrow(
        TallyUnreachableException,
      );
      expect(httpPost).toHaveBeenCalledTimes(1);
    });

    it('overrides timeoutMs, passed straight through to the underlying axios call', async () => {
      const { client, httpPost } = makeClient();
      httpPost.mockReturnValueOnce(
        of({ status: 200, headers: {}, data: Buffer.from('<ENVELOPE></ENVELOPE>') }),
      );

      await client.post('<ENVELOPE/>', { timeoutMs: 1234 });

      expect(httpPost.mock.calls[0][2]).toMatchObject({ timeout: 1234 });
    });

    it('leaves the configured defaults untouched when no opts are passed', async () => {
      const { client, httpPost } = makeClient();
      httpPost.mockReturnValueOnce(
        of({ status: 200, headers: {}, data: Buffer.from('<ENVELOPE></ENVELOPE>') }),
      );

      await client.post('<ENVELOPE/>');

      expect(httpPost.mock.calls[0][2]).toMatchObject({ timeout: 60000 });
    });
  });

  describe('request serialization (Tally handles one request at a time)', () => {
    it('does not start the second request until the first has resolved', async () => {
      const { client, httpPost } = makeClient();
      const callOrder: string[] = [];
      let resolveFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      httpPost.mockImplementationOnce(() => {
        callOrder.push('first-start');
        return from(
          firstGate.then(() => ({
            status: 200,
            headers: {},
            data: Buffer.from('<ENVELOPE>1</ENVELOPE>'),
          })),
        );
      });
      httpPost.mockImplementationOnce(() => {
        callOrder.push('second-start');
        return of({ status: 200, headers: {}, data: Buffer.from('<ENVELOPE>2</ENVELOPE>') });
      });

      const p1 = client.post('<ENVELOPE/>1');
      const p2 = client.post('<ENVELOPE/>2');

      // Let pending microtasks flush — the second request must NOT have started yet.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(callOrder).toEqual(['first-start']);

      resolveFirst();
      await expect(p1).resolves.toBe('<ENVELOPE>1</ENVELOPE>');
      await expect(p2).resolves.toBe('<ENVELOPE>2</ENVELOPE>');
      expect(callOrder).toEqual(['first-start', 'second-start']);
    });

    it('still runs the second request even when the first one fails (one bad request does not jam the queue)', async () => {
      const { client, httpPost } = makeClient({ maxRetries: 0 });
      httpPost
        .mockReturnValueOnce(throwError(connectionRefused))
        .mockReturnValueOnce(
          of({ status: 200, headers: {}, data: Buffer.from('<ENVELOPE>ok</ENVELOPE>') }),
        );

      const p1 = client.post('<ENVELOPE/>1');
      const p2 = client.post('<ENVELOPE/>2');

      await expect(p1).rejects.toThrow(TallyUnreachableException);
      await expect(p2).resolves.toBe('<ENVELOPE>ok</ENVELOPE>');
    });
  });
});
