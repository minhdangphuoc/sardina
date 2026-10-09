import { mapEngineLine, normalizeSeverity } from './pathMap';

/** The name of the output channel that streams Run / Debug / Deploy builds. */
export const BUILD_LOG_CHANNEL_NAME = 'Sardina Build';

/** `$ sfdk <args>` plus the start time, the first line of each sfdk step in the build log. */
export function formatStepHeader(argv: string[], now: Date): string {
  return `$ sfdk ${argv.join(' ')}  (${now.toISOString()})`;
}

/** `build finished (exit 0, 12.3s)`; a cancelled step says so instead of an exit code. */
export function formatStepFooter(stage: string, exitCode: number, durationMs: number, cancelled = false): string {
  const secs = `${(durationMs / 1000).toFixed(1)}s`;
  return cancelled ? `${stage} cancelled (${secs})` : `${stage} finished (exit ${exitCode}, ${secs})`;
}

/** Same rewriting as the build task's terminal: `fatal error` -> `error`, engine paths -> host paths. */
export function mapBuildLogLine(line: string, engineMapping: string | null, hostPath: string): string {
  const out = normalizeSeverity(line);
  return engineMapping ? mapEngineLine(out, engineMapping, hostPath) : out;
}
