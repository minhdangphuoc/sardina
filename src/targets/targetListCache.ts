import type { TargetDescriptor } from '../core/types';

/**
 * The most recently successfully-parsed `sfdk tools target list` result,
 * shared between selectTarget.ts (which populates it) and statusBar.ts
 * (which reads it for the FR-4.5 "Target not installed" warning). Module
 * state, not on `Services`, is deliberate: it is Task C's own cross-cutting
 * concern between two files it owns, not a contract other tasks read.
 */
let lastList: TargetDescriptor[] | undefined;

export function setLastTargetList(list: TargetDescriptor[]): void {
  lastList = list;
}

export function getLastTargetList(): TargetDescriptor[] | undefined {
  return lastList;
}

/** Test-only: resets module state between suites sharing one extension host process. */
export function resetLastTargetListForTests(): void {
  lastList = undefined;
}
