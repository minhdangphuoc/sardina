import type { ParseResult } from '../../core/types';

export type EngineRunningStatus = 'running' | 'stopped';

/**
 * Pure parsing for `sfdk engine status` output (FR-1.5/FR-16). No `vscode`
 * import so this can be unit-tested directly under plain mocha.
 */
export function parseEngineStatus(raw: string): ParseResult<EngineRunningStatus> {
  if (/is running/i.test(raw)) {
    return { ok: true, value: 'running', warnings: [] };
  }
  if (/is stopped/i.test(raw)) {
    return { ok: true, value: 'stopped', warnings: [] };
  }
  return { ok: false, reason: 'could not parse sfdk engine status output', raw };
}
