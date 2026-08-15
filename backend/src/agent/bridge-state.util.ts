import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';

/**
 * What a paired bridge knows about itself, persisted locally so it can skip
 * pairing on every restart. Deliberately NOT stored in `.env`: `.env` is for
 * static, operator-authored config (TALLY_HOST, GATEWAY_URL, ...); this is
 * dynamic state the bridge itself learns from a live pairing, and rewriting
 * `.env` on every re-pair is exactly what made bridge/server config easy to
 * confuse when they happen to share a directory. Plain JSON on disk, not
 * OS-keychain-backed — same deliberate scope boundary the old env-file
 * approach called out; secure storage is a separate, later hardening step.
 */
export interface BridgeState {
  agentToken: string;
  connectionId?: string;
  label?: string;
  defaultCompany?: string;
  /** ISO timestamp — diagnostic only, never read back for any decision. */
  pairedAt?: string;
}

export const DEFAULT_BRIDGE_STATE_PATH = resolve(process.cwd(), '.tally-bridge-state.json');

/**
 * Never throws — this runs at process boot, and a missing, unreadable, or
 * half-written file must fall through to "no saved state" (env var or fresh
 * pairing), not crash the bridge.
 */
export function readBridgeState(filePath: string): BridgeState | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<BridgeState>;
    if (!parsed.agentToken) return null;
    return parsed as BridgeState;
  } catch {
    return null;
  }
}

/** Full overwrite — unlike `.env`, this file holds nothing but pairing state, so there's no partial-update case to support. */
export function writeBridgeState(filePath: string, state: BridgeState): void {
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function clearBridgeState(filePath: string): void {
  if (existsSync(filePath)) unlinkSync(filePath);
}
