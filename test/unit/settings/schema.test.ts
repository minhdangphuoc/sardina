import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULTS } from '../../../src/settings/defaults';

/**
 * FR-2.1 (exact activationEvents set) and FR-14.1/14.2 (§4.6 settings
 * schema) have no other asserting test: M1.7 only checks for the absence of
 * "*", and check:manifest only checks that each declared key is read.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  activationEvents: string[];
  contributes: { configuration: { title: string; properties: Record<string, Record<string, unknown>> } };
};

const EXPECTED_ACTIVATION_EVENTS = [
  'workspaceContains:rpm/*.spec',
  'workspaceContains:**/*.pro',
  'workspaceContains:**/CMakeLists.txt',
  'onCommand:sardina.newProject',
  'onCommand:sardina.setSdkPath',
  'onCommand:sardina.downloadSdk',
  'onCommand:sardina.sdk.install',
  'onCommand:sardina.device.add',
  'onCommand:sardina.device.remove',
  'onCommand:sardina.setupSigning',
  'onView:sardina.build',
  'onView:sardina.sdk',
  'onView:sardina.devices',
  'onLanguage:qml',
];

interface RowSpec {
  key: string;
  type: string;
  default: unknown;
  scope: 'window' | 'resource' | 'machine';
  enum?: string[];
}

const EXPECTED_ROWS: RowSpec[] = [
  { key: 'sardina.sdkPath', type: 'string', default: '', scope: 'machine' },
  { key: 'sardina.devicesXmlPath', type: 'string', default: '', scope: 'machine' },
  { key: 'sardina.target', type: 'string', default: '', scope: 'resource' },
  { key: 'sardina.device', type: 'string', default: '', scope: 'resource' },
  { key: 'sardina.showSnapshotTargets', type: 'boolean', default: false, scope: 'window' },
  { key: 'sardina.build.jobs', type: 'integer', default: 0, scope: 'resource' },
  { key: 'sardina.build.runHarbourCheck', type: 'boolean', default: false, scope: 'resource' },
  { key: 'sardina.build.revealLog', type: 'boolean', default: true, scope: 'resource' },
  { key: 'sardina.build.extraArgs', type: 'array', default: [], scope: 'resource' },
  {
    key: 'sardina.deploy.method',
    type: 'string',
    default: 'sdk',
    scope: 'resource',
    enum: ['sdk', 'pkcon', 'rsync', 'zypper', 'zypper-dup', 'manual'],
  },
  {
    key: 'sardina.run.launcher',
    type: 'string',
    default: 'auto',
    scope: 'resource',
    enum: ['auto', 'invoker-silica', 'sailfish-qml', 'custom'],
  },
  { key: 'sardina.run.customCommand', type: 'string', default: '', scope: 'resource' },
  { key: 'sardina.run.killBeforeLaunch', type: 'boolean', default: true, scope: 'resource' },
  { key: 'sardina.debug.openDeviceMonitor', type: 'boolean', default: true, scope: 'resource' },
  { key: 'sardina.monitor.pollIntervalSeconds', type: 'integer', default: 5, scope: 'window' },
  { key: 'sardina.monitor.logLines', type: 'integer', default: 500, scope: 'window' },
  { key: 'sardina.build.type', type: 'string', default: 'release', scope: 'resource', enum: ['release', 'debug'] },
  { key: 'sardina.build.cleanOnArchChange', type: 'boolean', default: false, scope: 'resource' },
  { key: 'sardina.build.sign', type: 'boolean', default: false, scope: 'resource' },
  { key: 'sardina.build.signingUser', type: 'string', default: '', scope: 'resource' },
  { key: 'sardina.build.signingPassphraseFile', type: 'string', default: '', scope: 'resource' },
  { key: 'sardina.qtqml.silenceQmlls', type: 'boolean', default: true, scope: 'resource' },
  { key: 'sardina.qml.languageFeatures', type: 'boolean', default: true, scope: 'resource' },
  { key: 'sardina.logLevel', type: 'string', default: 'info', scope: 'window', enum: ['info', 'debug'] },
  { key: 'sardina.experimental.enableWindows', type: 'boolean', default: false, scope: 'machine' },
  {
    key: 'sardina.experimental.msys2Shell',
    type: 'string',
    default: 'C:\\msys64\\msys2_shell.cmd',
    scope: 'machine',
  },
];

describe('settings schema (FR-2.1, FR-14.1, FR-14.2)', () => {
  it('activationEvents is exactly the FR-2.1 set', () => {
    assert.deepStrictEqual(pkg.activationEvents, EXPECTED_ACTIVATION_EVENTS);
  });

  it('contributes.configuration.title is "Sardina"', () => {
    assert.strictEqual(pkg.contributes.configuration.title, 'Sardina');
  });

  for (const row of EXPECTED_ROWS) {
    it(`declares ${row.key} with the §4.6 type/default/scope/description`, () => {
      const prop = pkg.contributes.configuration.properties[row.key];
      assert.ok(prop, `expected package.json to declare ${row.key}`);
      assert.strictEqual(prop.type, row.type);
      assert.deepStrictEqual(prop.default, row.default);
      assert.strictEqual(prop.scope, row.scope);
      if (row.enum) {
        assert.deepStrictEqual(prop.enum, row.enum);
      }
      assert.strictEqual(typeof prop.markdownDescription, 'string');
      assert.ok((prop.markdownDescription as string).length > 0);
    });
  }

  it('declares exactly the §4.6 v0.1 keys, matching Object.keys(DEFAULTS)', () => {
    const declared = Object.keys(pkg.contributes.configuration.properties)
      .map((k) => k.replace(/^sardina\./, ''))
      .sort();
    const fromDefaults = Object.keys(DEFAULTS).sort();
    assert.deepStrictEqual(declared, fromDefaults);
  });
});
