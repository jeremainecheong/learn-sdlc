/**
 * The exit code every command line tool under cli/ gives a failure it did not
 * expect: a throw that escaped its main. It is apart from each tool's own
 * documented outcomes, so a script can tell a crash from a real answer. 70 is
 * EX_SOFTWARE in sysexits.h, "an internal software error".
 */
export const CLI_CRASH_EXIT = 70;

/**
 * Runs a tool's main and exits with the code it returns, or prints the
 * message of whatever it threw and exits with CLI_CRASH_EXIT. `exit` and
 * `error` are parameters so a spec can watch them.
 */
export function runCli(
  main: () => Promise<number>,
  exit: (code: number) => void = (code) => process.exit(code),
  error: (line: unknown) => void = console.error,
): Promise<void> {
  return main().then(
    (code) => exit(code),
    (err: unknown) => {
      error(err instanceof Error ? err.message : err);
      exit(CLI_CRASH_EXIT);
    },
  );
}
