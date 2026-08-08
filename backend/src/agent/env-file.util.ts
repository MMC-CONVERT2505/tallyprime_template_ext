import { existsSync, readFileSync, writeFileSync } from 'fs';

/**
 * Sets `KEY=value` in a `.env`-style file in place — replacing an existing
 * (even commented-out, e.g. `# AGENT_TOKEN=...`) line for that key, or
 * appending a new one if it's absent. This is what lets the connector bridge
 * persist a device-flow-obtained token itself, so the next restart doesn't
 * need to re-pair — no human ever edits this file for that purpose.
 *
 * Deliberately a plain text-file edit, not a secure-storage write: this is
 * the same `.env` the bridge already reads via dotenv (see agent.module.ts).
 * Swapping the storage backend entirely (OS keychain/Credential Manager) is
 * a separate, later hardening step — see docs/architecture.md.
 */
export function upsertEnvValue(filePath: string, key: string, value: string): void {
  const content = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const line = `${key}=${value}`;
  // Matches an active or commented-out assignment for this exact key, on its own line.
  const pattern = new RegExp(`^[ \\t]*#?[ \\t]*${escapeRegExp(key)}=.*$`, 'm');

  const next = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.replace(/\s*$/, '')}\n${line}\n`.replace(/^\n/, '');

  writeFileSync(filePath, next, 'utf-8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
