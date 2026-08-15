import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearBridgeState, readBridgeState, writeBridgeState } from './bridge-state.util';

describe('bridge-state.util', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-state-util-'));
    filePath = join(dir, '.tally-bridge-state.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('readBridgeState', () => {
    it('returns null when the file does not exist', () => {
      expect(readBridgeState(filePath)).toBeNull();
    });

    it('returns null (not a throw) when the file contains invalid JSON', () => {
      writeFileSync(filePath, '{ not valid json', 'utf-8');

      expect(readBridgeState(filePath)).toBeNull();
    });

    it('returns null when the parsed JSON is missing agentToken', () => {
      writeFileSync(filePath, JSON.stringify({ connectionId: 'conn-1' }), 'utf-8');

      expect(readBridgeState(filePath)).toBeNull();
    });
  });

  describe('writeBridgeState / readBridgeState round trip', () => {
    it('round-trips the full state object', () => {
      const state = {
        agentToken: 'conn-1.secret',
        connectionId: 'conn-1',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
        pairedAt: '2026-08-15T00:00:00.000Z',
      };

      writeBridgeState(filePath, state);

      expect(readBridgeState(filePath)).toEqual(state);
    });

    it('fully replaces prior content on a second write — no merge, no stray leftover fields', () => {
      writeBridgeState(filePath, { agentToken: 'a', connectionId: 'c1' });
      writeBridgeState(filePath, { agentToken: 'b' });

      const result = readBridgeState(filePath);
      expect(result?.agentToken).toBe('b');
      expect(result).not.toHaveProperty('connectionId');
    });
  });

  describe('clearBridgeState', () => {
    it('removes an existing file', () => {
      writeBridgeState(filePath, { agentToken: 'a' });

      clearBridgeState(filePath);

      expect(existsSync(filePath)).toBe(false);
    });

    it('is a no-op on a nonexistent file (does not throw)', () => {
      expect(() => clearBridgeState(filePath)).not.toThrow();
    });
  });
});
