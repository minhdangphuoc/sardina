import { execFile } from 'node:child_process';

function pgrep(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pgrep', args, (error) => resolve(!error)); // pgrep exits 1 (an "error" to execFile) when nothing matches
  });
}

/** FR-7.6: warns before writing devices.xml if Qt Creator or sfdk might be running and could overwrite the file. */
export async function conflictingProcessesRunning(): Promise<boolean> {
  const [qtCreator, sfdk] = await Promise.all([pgrep(['-x', 'qtcreator']), pgrep(['-f', 'bin/sfdk'])]);
  return qtCreator || sfdk;
}
