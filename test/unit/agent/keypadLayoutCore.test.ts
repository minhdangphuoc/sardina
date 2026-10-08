import * as assert from 'assert';
import {
  buildDefaultKeypadLayout,
  keypadLayoutFileName,
  parseKeypadInfo,
  parseKeypadLayout,
  validateKeypadLayout,
  type KeypadInfo,
} from '../../../src/agent/keypadLayoutCore';

const info: KeypadInfo = {
  model: 'Commodore Callback',
  keys: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#', 'OK', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'MENU', 'BACK', 'CALL', 'F21', 'F22', 'F23'],
};

describe('keypad layout parser and validator', () => {
  it('parses JSON separately from schema validation', () => {
    assert.deepStrictEqual(parseKeypadLayout('{"model":"X","rows":[["1"]]}').value, { model: 'X', rows: [['1']] });
    assert.match(parseKeypadLayout('{no').error ?? '', /^Invalid JSON:/);
  });

  it('accepts shorthand and labelled cells with the two styles', () => {
    const checked = validateKeypadLayout({
      model: info.model,
      rows: [
        ['1', null, { key: 'OK', label: 'Select', style: 'primary' }],
        [{ key: 'CALL', label: 'Call', style: 'call' }],
      ],
    }, info.keys, info.model);
    assert.deepStrictEqual(checked.errors, []);
    assert.deepStrictEqual(checked.warnings, []);
    assert.deepStrictEqual(checked.layout?.rows, [
      [{ key: '1', label: '1' }, null, { key: 'OK', label: 'Select', style: 'primary' }],
      [{ key: 'CALL', label: 'Call', style: 'call' }],
    ]);
  });

  it('drops unknown and unavailable keys but keeps a usable layout', () => {
    const checked = validateKeypadLayout({ model: info.model, rows: [['1', 'POWER', 'F23']] }, ['1'], info.model);
    assert.deepStrictEqual(checked.errors, []);
    assert.deepStrictEqual(checked.layout?.rows, [[{ key: '1', label: '1' }, null, null]]);
    assert.strictEqual(checked.warnings.length, 2);
    assert.ok(checked.warnings.some((warning) => warning.includes('unknown key')));
    assert.ok(checked.warnings.some((warning) => warning.includes('not exposed')));
  });

  it('rejects malformed structure, labels, styles and the wrong model together', () => {
    const checked = validateKeypadLayout({
      model: 'Other',
      rows: [[{ key: 'OK', label: '', style: 'wide', extra: true }], []],
      extra: true,
    }, info.keys, info.model);
    assert.ok(checked.layout === undefined);
    assert.ok(checked.errors.some((error) => error.includes('top-level')));
    assert.ok(checked.errors.some((error) => error.includes('model must be')));
    assert.ok(checked.errors.some((error) => error.includes('unknown cell field')));
    assert.ok(checked.errors.some((error) => error.includes('1–20 cells')));
  });
});

describe('default keypad layout', () => {
  it('builds navigation, numeric and function rows from only exposed keys', () => {
    const layout = buildDefaultKeypadLayout(info);
    assert.strictEqual(layout.model, info.model);
    assert.deepStrictEqual(layout.rows[0].map((cell) => cell?.key ?? null), ['MENU', 'UP', 'BACK']);
    assert.deepStrictEqual(layout.rows[1].map((cell) => cell?.key ?? null), ['LEFT', 'OK', 'RIGHT']);
    assert.deepStrictEqual(layout.rows.slice(3, 7).map((row) => row.map((cell) => cell?.key ?? null)), [
      ['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['*', '0', '#'],
    ]);
    assert.deepStrictEqual(layout.rows.at(-1)?.map((cell) => cell?.key ?? null), ['F21', 'F22', 'F23']);
  });

  it('keeps placeholders but removes rows with no exposed key', () => {
    const layout = buildDefaultKeypadLayout({ model: 'Small', keys: ['OK', '0'] });
    assert.deepStrictEqual(layout.rows.map((row) => row.map((cell) => cell?.key ?? null)), [
      [null, 'OK', null],
      [null, '0', null],
    ]);
  });

  it('normalizes the model into the override file name', () => {
    assert.strictEqual(keypadLayoutFileName('Commodore Callback'), 'commodore-callback.json');
    assert.strictEqual(keypadLayoutFileName('  Ä/B  '), 'a-b.json');
  });

  it('strictly parses the keypad capability', () => {
    assert.deepStrictEqual(parseKeypadInfo({ model: 'Commodore Callback', keys: ['1', 'OK'] }), {
      model: 'Commodore Callback', keys: ['1', 'OK'],
    });
    assert.strictEqual(parseKeypadInfo({ model: 'X', keys: ['POWER'] }), undefined);
    assert.strictEqual(parseKeypadInfo({ model: 'X', keys: ['1', '1'] }), undefined);
  });
});
