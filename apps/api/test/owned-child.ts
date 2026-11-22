import type { ChildProcess } from 'child_process';

/** Test fixture cleanup also runs when setup failed before its ready signal. */
export async function stopOwnedChild(child: ChildProcess | undefined, graceMs = 5_000): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let escalation: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const finish = () => {
      if (escalation) clearTimeout(escalation);
      if (deadline) clearTimeout(deadline);
      child.off('exit', finish);
      resolve();
    };
    child.once('exit', finish);
    escalation = setTimeout(() => {
      child.kill('SIGKILL');
      deadline = setTimeout(() => {
        child.off('exit', finish);
        reject(new Error('Owned test child did not exit after forced cleanup'));
      }, graceMs);
    }, graceMs);
    child.kill('SIGTERM');
  });
}
