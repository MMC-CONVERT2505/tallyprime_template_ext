import { formatConnectionToken, parseConnectionToken } from './token.util';

describe('token.util', () => {
  it('round-trips id and secret through format/parse', () => {
    const token = formatConnectionToken('conn-1', 'abc123secret');
    expect(parseConnectionToken(token)).toEqual({ id: 'conn-1', secret: 'abc123secret' });
  });

  it('splits on the first dot only, so a secret containing a dot survives intact', () => {
    const token = formatConnectionToken('conn-1', 'sec.ret.with.dots');
    expect(parseConnectionToken(token)).toEqual({ id: 'conn-1', secret: 'sec.ret.with.dots' });
  });

  it('rejects tokens with no dot, an empty id, or an empty secret', () => {
    expect(parseConnectionToken('no-dot-here')).toBeNull();
    expect(parseConnectionToken('.secret-only')).toBeNull();
    expect(parseConnectionToken('id-only.')).toBeNull();
    expect(parseConnectionToken('')).toBeNull();
  });
});
