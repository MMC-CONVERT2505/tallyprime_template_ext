/**
 * Device token shape: `${connectionId}.${secret}`. The id is embedded so the
 * gateway can look the row up directly instead of scanning every active
 * connection's hash — same idea as GitHub/Stripe-style prefixed API keys.
 * Shared between ConnectionsService (mints tokens) and TallyTunnelGateway
 * (verifies them) so the format can't drift between the two.
 */
export function parseConnectionToken(raw: string): { id: string; secret: string } | null {
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  return { id: raw.slice(0, dot), secret: raw.slice(dot + 1) };
}

export function formatConnectionToken(id: string, secret: string): string {
  return `${id}.${secret}`;
}
