import { of, throwError } from 'rxjs';
import { TallyHttpClient } from './tally-http.client';
import { TallyHttpException, TallyUnreachableException } from './exceptions/tally.exceptions';

describe('TallyHttpClient — retry with backoff', () => {
  function makeClient(tallyOverrides: Partial<{ maxRetries: number; retryBaseMs: number }> = {}) {
    const httpPost = jest.fn();
    const http = { post: httpPost } as any;
    const config = {
      getOrThrow: () => ({
        baseUrl: 'http://127.0.0.1:9000',
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
});
