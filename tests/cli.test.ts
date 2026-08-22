import { describe, it, expect, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import pkg from '../package.json' with { type: 'json' };

describe('TriCache CLI (src/cli.ts)', () => {
  it('prints version number when called with --version', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['--version']);
    // Read from package.json — a hardcoded literal drifts on every release.
    expect(logSpy).toHaveBeenCalledWith(`tricache v${pkg.version}`);
    logSpy.mockRestore();
  });

  it('prints help message when called with --help', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['--help']);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('TriCache CLI — Developer & Troubleshooting Tool');
    logSpy.mockRestore();
  });

  it('executes ping command successfully against local L1 / disk', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['ping', '--namespace', 'test-cli-ping']);
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('TriCache Ping Results:');
    expect(output).toContain('L1 RAM:');
    logSpy.mockRestore();
  });

  it('executes inspect dashboard command cleanly', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['inspect', '--namespace', 'test-cli-inspect']);
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('TriCache Engine Dashboard');
    expect(output).toContain('L1 Hit Ratio:');
    logSpy.mockRestore();
  });

  it('executes clear command cleanly', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['clear', '--namespace', 'test-cli-clear', '--prefix', 'user:']);
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Cleared cache for prefix "user:"');
    logSpy.mockRestore();
  });
});
