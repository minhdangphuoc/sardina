import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fixturesRoot } from './helpers';

interface WalkthroughStep {
  id: string;
  title: string;
  media?: { markdown?: string };
  completionEvents?: string[];
}

interface Walkthrough {
  id: string;
  title: string;
  steps: WalkthroughStep[];
}

interface PackageJson {
  contributes: {
    commands?: { command: string }[];
    walkthroughs?: Walkthrough[];
  };
}

function readPackageJson(): PackageJson {
  const pkgPath = path.resolve(fixturesRoot(), '..', '..', 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
}

/**
 * FR-15.1/AC-1.12: validates the manifest's walkthrough shape directly
 * rather than driving the real Getting Started UI, which vscode-test does
 * not expose a stable API for.
 */
suite('walkthrough (FR-15.1, AC-1.12)', () => {
  test('sardina.gettingStarted has exactly 5 steps, no addDevice (v0.2)', () => {
    const pkg = readPackageJson();
    const walkthrough = pkg.contributes.walkthroughs?.find((w) => w.id === 'sardina.gettingStarted');
    assert.ok(walkthrough, 'expected a sardina.gettingStarted walkthrough');

    const ids = walkthrough?.steps.map((s) => s.id) ?? [];
    assert.strictEqual(ids.length, 5, `expected exactly 5 steps, got: ${ids.join(', ')}`);
    assert.deepStrictEqual(ids, ['installSdk', 'createProject', 'selectTarget', 'startEmulator', 'buildDeployRun']);
    assert.ok(!ids.includes('addDevice'), 'addDevice is v0.2 and must not appear in v0.1');
  });

  test('every completionEvent references a declared command or context key', () => {
    const pkg = readPackageJson();
    const walkthrough = pkg.contributes.walkthroughs?.find((w) => w.id === 'sardina.gettingStarted');
    assert.ok(walkthrough);

    const declaredCommands = new Set((pkg.contributes.commands ?? []).map((c) => c.command));
    // src/core/contextKeys.ts's ALL_KEYS; kept in sync manually since that
    // file has no vscode-free export a Node script can import directly.
    const declaredContextKeys = new Set([
      'sardina.isProject',
      'sardina.projectCount',
      'sardina.sdkAvailable',
      'sardina.platformSupported',
      'sardina.hasTarget',
      'sardina.hasDevice',
    ]);

    for (const step of walkthrough?.steps ?? []) {
      for (const event of step.completionEvents ?? []) {
        if (event.startsWith('onCommand:')) {
          const command = event.slice('onCommand:'.length);
          assert.ok(declaredCommands.has(command), `step "${step.id}": undeclared command in completionEvent: ${command}`);
        } else if (event.startsWith('onContext:')) {
          const key = event.slice('onContext:'.length);
          assert.ok(declaredContextKeys.has(key), `step "${step.id}": undeclared context key in completionEvent: ${key}`);
        } else {
          assert.fail(`step "${step.id}": unrecognized completionEvent shape: ${event}`);
        }
      }
    }
  });

  test('every step has markdown media under media/walkthrough with real content', () => {
    const pkg = readPackageJson();
    const walkthrough = pkg.contributes.walkthroughs?.find((w) => w.id === 'sardina.gettingStarted');
    assert.ok(walkthrough);
    const repoRoot = path.resolve(fixturesRoot(), '..', '..');

    for (const step of walkthrough?.steps ?? []) {
      const mdPath = step.media?.markdown;
      assert.ok(mdPath, `step "${step.id}" has no media.markdown`);
      const full = path.join(repoRoot, mdPath ?? '');
      assert.ok(fs.existsSync(full), `media file missing: ${mdPath}`);
      const content = fs.readFileSync(full, 'utf8').trim();
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      assert.ok(lines.length > 1, `step "${step.id}" media is just a placeholder heading: ${mdPath}`);
    }
  });
});
