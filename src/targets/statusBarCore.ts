/**
 * Pure FR-4.1/FR-4.5 status bar text/visibility computation. No `vscode`
 * import so this can be unit-tested directly under plain mocha; statusBar.ts
 * wires this to a real `vscode.StatusBarItem`.
 */
export interface StatusBarState {
  visible: boolean;
  text: string;
  tooltip: string | undefined;
}

const NOT_INSTALLED_TOOLTIP = 'Target not installed';

export function computeStatusBarState(opts: {
  isProject: boolean;
  sdkAvailable: boolean;
  target: string;
  knownTargetNames: string[] | undefined;
}): StatusBarState {
  const { isProject, sdkAvailable, target, knownTargetNames } = opts;
  const visible = isProject && sdkAvailable;

  if (!target) {
    return { visible, text: '$(circuit-board) Select SFOS target', tooltip: undefined };
  }

  const missing = knownTargetNames !== undefined && !knownTargetNames.includes(target);
  if (missing) {
    return {
      visible,
      text: `$(warning) $(circuit-board) ${target}`,
      tooltip: NOT_INSTALLED_TOOLTIP,
    };
  }
  return { visible, text: `$(circuit-board) ${target}`, tooltip: undefined };
}
