import { spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import { stopOwnedChild } from './owned-child';

describe('owned fixture process cleanup after failed setup', () => {
  const owned: ChildProcess[] = [];
  afterEach(async () => { await Promise.all(owned.splice(0).map(child => stopOwnedChild(child, 200))); });
  async function running(source: string) {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'] });
    owned.push(child); await once(child.stdout!, 'data'); return child;
  }
  it('terminates a started child even if no fixture environment was installed', async () => {
    const child = await running("process.stdout.write('ready'); setInterval(() => {}, 1000)");
    await stopOwnedChild(child, 200);
    expect(child.signalCode).toBe('SIGTERM');
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
  it('waits for a TERM-resistant child to exit after KILL', async () => {
    const child = await running("process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)");
    await stopOwnedChild(child, 100);
    expect(child.signalCode).toBe('SIGKILL');
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
  it('also handles missing and already exited children', async () => {
    await stopOwnedChild(undefined, 100);
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    owned.push(child); await once(child, 'exit');
    await stopOwnedChild(child, 100);
    expect(child.exitCode).toBe(0);
  });
});
