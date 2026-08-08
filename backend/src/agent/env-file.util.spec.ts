import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { upsertEnvValue } from './env-file.util';

describe('upsertEnvValue', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'env-file-util-'));
    filePath = join(dir, '.env');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file with the key/value when it does not exist yet', () => {
    upsertEnvValue(filePath, 'AGENT_TOKEN', 'abc.def');

    expect(readFileSync(filePath, 'utf-8')).toBe('AGENT_TOKEN=abc.def\n');
  });

  it('appends the key when the file exists but lacks it, preserving existing content', () => {
    writeFileSync(filePath, 'FOO=bar\n');

    upsertEnvValue(filePath, 'AGENT_TOKEN', 'abc.def');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('FOO=bar');
    expect(content).toContain('AGENT_TOKEN=abc.def');
  });

  it('replaces an existing active value in place, leaving other lines untouched', () => {
    writeFileSync(filePath, 'FOO=bar\nAGENT_TOKEN=old-value\nBAZ=qux\n');

    upsertEnvValue(filePath, 'AGENT_TOKEN', 'new-value');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('AGENT_TOKEN=new-value');
    expect(content).not.toContain('old-value');
    expect(content).toContain('FOO=bar');
    expect(content).toContain('BAZ=qux');
  });

  it('replaces a commented-out placeholder line (the .env.example convention)', () => {
    writeFileSync(
      filePath,
      '# Agent side:\n# AGENT_TOKEN=<value returned once by POST /connections>\n# GATEWAY_URL=ws://127.0.0.1:3000/agent-tunnel\n',
    );

    upsertEnvValue(filePath, 'AGENT_TOKEN', 'real.token');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('AGENT_TOKEN=real.token');
    expect(content).not.toContain('<value returned once');
    expect(content).toContain('# GATEWAY_URL=ws://127.0.0.1:3000/agent-tunnel'); // untouched
  });

  it('is idempotent — setting the same value twice yields one line, not a duplicate', () => {
    upsertEnvValue(filePath, 'AGENT_TOKEN', 'abc.def');
    upsertEnvValue(filePath, 'AGENT_TOKEN', 'abc.def');

    const matches = readFileSync(filePath, 'utf-8').match(/AGENT_TOKEN=/g);
    expect(matches).toHaveLength(1);
  });
});
