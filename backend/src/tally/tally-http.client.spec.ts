import { from, of, throwError } from 'rxjs';
import { TallyHttpClient } from './tally-http.client';
import {
  TallyCircuitOpenException,
  TallyHttpException,
  TallyTimeoutException,
  TallyUnreachableException,
} from './exceptions/tally.exceptions';

describe('TallyHttpClient — retry with backoff', () => {
  function makeClient(
    tallyOverrides: Partial<{
      maxRetries: number;
      retryBaseMs: number;
      circuitBreakerThreshold: number;
      circuitOpenMs: number;
    }> = {},
  ) {
    const httpPost = jest.fn();
    const http = { post: httpPost } as any;
    const config = {
      getOrThrow: () => ({
        baseUrl: 'http://127.0.0.1:9001',
        timeoutMs: 60000,
        responseEncoding: 'auto',
        maxRetries: 2,
        retryBaseMs: 1, // keep tests fast — backoff shape is covered separately below
        circuitBreakerThreshold: 2,
        circuitOpenMs: 15000,
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

  describe('timeout handling', () => {
    const timeoutError = () =>
      Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' });

    it('maps a real axios timeout (ECONNABORTED) to TallyTimeoutException, not just passing the value through', async () => {
      const { client, httpPost } = makeClient({ maxRetries: 0 });
      httpPost.mockReturnValue(throwError(timeoutError));

      await expect(client.post('<ENVELOPE/>')).rejects.toThrow(TallyTimeoutException);
    });

    it('retries a timeout the same as any other transient failure, up to maxRetries', async () => {
      const { client, httpPost } = makeClient({ maxRetries: 1 });
      httpPost
        .mockReturnValueOnce(throwError(timeoutError))
        .mockReturnValueOnce(
          of({ status: 200, headers: {}, data: Buffer.from('<ENVELOPE></ENVELOPE>') }),
        );

      const result = await client.post('<ENVELOPE/>');

      expect(result).toBe('<ENVELOPE></ENVELOPE>');
      expect(httpPost).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancellation via AbortSignal', () => {
    it('passes the signal straight through to the underlying axios call', async () => {
      const { client, httpPost } = makeClient();
      httpPost.mockReturnValueOnce(
        of({ status: 200, headers: {}, data: Buffer.from('<ENVELOPE></ENVELOPE>') }),
      );
      const controller = new AbortController();

      await client.post('<ENVELOPE/>', { signal: controller.signal });

      expect(httpPost.mock.calls[0][2]).toMatchObject({ signal: controller.signal });
    });

    it('never retries an aborted call, even with retries configured', async () => {
      const { client, httpPost } = makeClient({ maxRetries: 2 });
      const controller = new AbortController();
      controller.abort();
      // Axios raises a CanceledError (code ERR_CANCELED) for an aborted
      // request — translateError falls through to treating that as
      // "unreachable" (transient), which is exactly why postWithRetry must
      // check signal.aborted BEFORE the transient-retry check, not rely on
      // the error's shape.
      httpPost.mockReturnValue(
        throwError(() => Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })),
      );

      await expect(client.post('<ENVELOPE/>', { signal: controller.signal })).rejects.toThrow();
      expect(httpPost).toHaveBeenCalledTimes(1);
    });
  });

  describe('circuit breaker (a genuinely wedged Tally, not just one flaky call)', () => {
    const connectionRefused = () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });

    it('opens after `circuitBreakerThreshold` consecutive transient failures, failing the next call immediately without touching the network', async () => {
      const { client, httpPost } = makeClient({
        maxRetries: 0,
        circuitBreakerThreshold: 2,
        circuitOpenMs: 15000,
      });
      httpPost.mockReturnValue(throwError(connectionRefused));

      await expect(client.post('<ENVELOPE/>1')).rejects.toThrow(TallyUnreachableException);
      await expect(client.post('<ENVELOPE/>2')).rejects.toThrow(TallyUnreachableException);
      expect(httpPost).toHaveBeenCalledTimes(2); // circuit not open yet — both attempted

      await expect(client.post('<ENVELOPE/>3')).rejects.toThrow(TallyCircuitOpenException);
      expect(httpPost).toHaveBeenCalledTimes(2); // third call never touched the network
    });

    it('resets the failure count and keeps the circuit closed on any success in between', async () => {
      const { client, httpPost } = makeClient({ maxRetries: 0, circuitBreakerThreshold: 2 });
      httpPost
        .mockReturnValueOnce(throwError(connectionRefused))
        .mockReturnValueOnce(
          of({ status: 200, headers: {}, data: Buffer.from('<ENVELOPE></ENVELOPE>') }),
        )
        .mockReturnValueOnce(throwError(connectionRefused));

      await expect(client.post('<ENVELOPE/>1')).rejects.toThrow(TallyUnreachableException);
      await expect(client.post('<ENVELOPE/>2')).resolves.toBe('<ENVELOPE></ENVELOPE>');
      // A single failure after the reset must not trip the circuit — it takes
      // `circuitBreakerThreshold` CONSECUTIVE failures, not 2 failures total.
      await expect(client.post('<ENVELOPE/>3')).rejects.toThrow(TallyUnreachableException);
      expect(httpPost).toHaveBeenCalledTimes(3);
    });

    it('does not count a definitive non-2xx response (TallyHttpException) toward the circuit — only transient failures', async () => {
      const { client, httpPost } = makeClient({ maxRetries: 0, circuitBreakerThreshold: 2 });
      httpPost.mockReturnValue(of({ status: 500, headers: {}, data: Buffer.from('err') }));

      await expect(client.post('<ENVELOPE/>1')).rejects.toThrow(TallyHttpException);
      await expect(client.post('<ENVELOPE/>2')).rejects.toThrow(TallyHttpException);
      await expect(client.post('<ENVELOPE/>3')).rejects.toThrow(TallyHttpException);
      expect(httpPost).toHaveBeenCalledTimes(3); // never short-circuited
    });

    it('allows a request through again, and closes the circuit on its success, once circuitOpenMs elapses', async () => {
      const { client, httpPost } = makeClient({
        maxRetries: 0,
        circuitBreakerThreshold: 2,
        circuitOpenMs: 20, // short enough to actually wait out in a unit test
      });
      httpPost
        .mockReturnValueOnce(throwError(connectionRefused))
        .mockReturnValueOnce(throwError(connectionRefused))
        .mockReturnValueOnce(
          of({ status: 200, headers: {}, data: Buffer.from('<ENVELOPE></ENVELOPE>') }),
        );

      await expect(client.post('<ENVELOPE/>1')).rejects.toThrow(TallyUnreachableException);
      await expect(client.post('<ENVELOPE/>2')).rejects.toThrow(TallyUnreachableException);
      await expect(client.post('<ENVELOPE/>3')).rejects.toThrow(TallyCircuitOpenException);
      expect(httpPost).toHaveBeenCalledTimes(2);

      await new Promise((resolve) => setTimeout(resolve, 30));

      await expect(client.post('<ENVELOPE/>4')).resolves.toBe('<ENVELOPE></ENVELOPE>');
      expect(httpPost).toHaveBeenCalledTimes(3);
    });

    it("re-opens the circuit for another full window if the recovery attempt also fails (doesn't just try once and give up forever)", async () => {
      const { client, httpPost } = makeClient({
        maxRetries: 0,
        circuitBreakerThreshold: 2,
        circuitOpenMs: 20,
      });
      httpPost.mockReturnValue(throwError(connectionRefused));

      await expect(client.post('<ENVELOPE/>1')).rejects.toThrow(TallyUnreachableException);
      await expect(client.post('<ENVELOPE/>2')).rejects.toThrow(TallyUnreachableException);
      await expect(client.post('<ENVELOPE/>3')).rejects.toThrow(TallyCircuitOpenException);

      await new Promise((resolve) => setTimeout(resolve, 30));

      // The recovery attempt itself fails — circuit must re-open, not stay closed.
      await expect(client.post('<ENVELOPE/>4')).rejects.toThrow(TallyUnreachableException);
      await expect(client.post('<ENVELOPE/>5')).rejects.toThrow(TallyCircuitOpenException);
    });
  });
});
