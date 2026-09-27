import type { ParseResult } from '../../core/types';
import { parseVersionOutput } from './version';
import { parseTargetList } from '../../targets/parseTargetList';
import { parseInitList } from '../../wizard/parseInitList';
import { parseDeviceList, parseEmulatorList } from '../../devices/listParsing';
import { parseEngineStatus } from './engineStatus';

export interface ParserEntry<T = unknown> {
  name: string;
  parse: (raw: string) => ParseResult<T>;
  /** Directory under test/fixtures/sfdk/parsers/<command>/ holding sample stdout. */
  fixtureDir: string;
}

/** Registry consumed by test/fuzz/parsers.fuzz.test.ts: every sfdk output parser, so the fuzz harness exercises them all (R5). */
export const allParsers: ParserEntry[] = [
  { name: 'version', parse: parseVersionOutput, fixtureDir: 'version' },
  { name: 'targetList', parse: parseTargetList, fixtureDir: 'target-list' },
  { name: 'initList', parse: parseInitList, fixtureDir: 'init-list' },
  { name: 'deviceList', parse: parseDeviceList, fixtureDir: 'device-list' },
  { name: 'emulatorList', parse: parseEmulatorList, fixtureDir: 'emulator-list' },
  { name: 'runningStatus', parse: parseEngineStatus, fixtureDir: 'engine-status' },
];
