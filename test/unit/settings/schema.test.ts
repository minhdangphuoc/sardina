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
  'onCommand:sailfish.newProject',
  'onCommand:sailfish.setSdkPath',
  'onCommand:sailfish.downloadSdk',
  'onCommand:sailfish.device.add',
  'onCommand:sailfish.device.remove',
  'onView:sailfish.devices',
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
  { key: 'sailfish.sdkPath', type: 'string', default: '', scope: 'machine' },
  { key: 'sailfish.devicesXmlPath', type: 'string', default: '', scope: 'machine' },
  { key: 'sailfish.target', type: 'string', default: '', scope: 'resource' },
  { key: 'sailfish.device', type: 'string', default: '', scope: 'resource' },
  { key: 'sailfish.showSnapshotTargets', type: 'boolean', default: false, scope: 'window' },
  { key: 'sailfish.build.jobs', type: 'integer', default: 0, scope: 'resource' },
  { key: 'sailfish.build.runHarbourCheck', type: 'boolean', default: false, scope: 'resource' },
  { key: 'sailfish.build.extraArgs', type: 'array', default: [], scope: 'resource' },
  {
    key: 'sailfish.deploy.method',
    type: 'string',
    default: 'sdk',
    scope: 'resource',
    enum: ['sdk', 'pkcon', 'rsync', 'zypper', 'zypper-dup', 'manual'],
  },
  {
    key: 'sailfish.run.launcher',
    type: 'string',
    default: 'auto',
    scope: 'resource',
    enum: ['auto', 'invoker-silica', 'sailfish-qml', 'custom'],
  },
  { key: 'sailfish.run.customCommand', type: 'string', default: '', scope: 'resource' },
  { key: 'sailfish.run.killBeforeLaunch', type: 'boolean', default: true, scope: 'resource' },
  { key: 'sailfish.qtqml.silenceQmlls', type: 'boolean', default: true, scope: 'window' },
  { key: 'sailfish.logLevel', type: 'string', default: 'info', scope: 'window', enum: ['info', 'debug'] },
  { key: 'sailfish.experimental.enableWindows', type: 'boolean', default: false, scope: 'machine' },
  {
    key: 'sailfish.experimental.msys2Shell',
    type: 'string',
    default: 'C:\\msys64\\msys2_shell.cmd',
    scope: 'machine',
  },
];

describe('settings schema (FR-2.1, FR-14.1, FR-14.2)', () => {
  it('activationEvents is exactly the FR-2.1 set', () => {
    assert.deepStrictEqual(pkg.activationEvents, EXPECTED_ACTIVATION_EVENTS);
  });

  it('contributes.configuration.title is "Sailfish OS"', () => {
    assert.strictEqual(pkg.contributes.configuration.title, 'Sailfish OS');
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
      .map((k) => k.replace(/^sailfish\./, ''))
      .sort();
    const fromDefaults = Object.keys(DEFAULTS).sort();
    assert.deepStrictEqual(declared, fromDefaults);
  });
});
