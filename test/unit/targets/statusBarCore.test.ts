import * as assert from 'assert';
import { computeStatusBarState } from '../../../src/targets/statusBarCore';

describe('computeStatusBarState (FR-4.1/FR-4.5)', () => {
  it('no target set: prompt text, visible iff isProject && sdkAvailable', () => {
    const state = computeStatusBarState({ isProject: true, sdkAvailable: true, target: '', knownTargetNames: undefined });
    assert.strictEqual(state.text, '$(circuit-board) Select Sailfish OS target');
    assert.strictEqual(state.visible, true);
    assert.strictEqual(state.tooltip, undefined);
  });

  it('hidden when not a project or sdk unavailable', () => {
    assert.strictEqual(
      computeStatusBarState({ isProject: false, sdkAvailable: true, target: '', knownTargetNames: undefined }).visible,
      false,
    );
    assert.strictEqual(
      computeStatusBarState({ isProject: true, sdkAvailable: false, target: '', knownTargetNames: undefined }).visible,
      false,
    );
  });

  it('target set and present in the known list: plain text, no warning', () => {
    const state = computeStatusBarState({
      isProject: true,
      sdkAvailable: true,
      target: 'SailfishOS-4.4.0.58-aarch64',
      knownTargetNames: ['SailfishOS-4.4.0.58-aarch64', 'SailfishOS-4.4.0.58-armv7hl'],
    });
    assert.strictEqual(state.text, '$(circuit-board) SailfishOS-4.4.0.58-aarch64');
    assert.strictEqual(state.tooltip, undefined);
  });

  it('FR-4.5: target set but absent from the known list gets a $(warning) prefix and tooltip', () => {
    const state = computeStatusBarState({
      isProject: true,
      sdkAvailable: true,
      target: 'SailfishOS-9.9.9.9-aarch64',
      knownTargetNames: ['SailfishOS-4.4.0.58-aarch64'],
    });
    assert.strictEqual(state.text, '$(warning) $(circuit-board) SailfishOS-9.9.9.9-aarch64');
    assert.strictEqual(state.tooltip, 'Target not installed');
  });

  it('no known list yet (never fetched): no warning even though target is set', () => {
    const state = computeStatusBarState({
      isProject: true,
      sdkAvailable: true,
      target: 'SailfishOS-4.4.0.58-aarch64',
      knownTargetNames: undefined,
    });
    assert.strictEqual(state.tooltip, undefined);
  });
});
