import * as assert from 'assert';
import { controlGlyphs, sanitizeField, stripAnsi } from '../../../src/monitor/displayText';

describe('stripAnsi', () => {
  it('removes colour and cursor sequences', () => {
    assert.strictEqual(stripAnsi('\u001b[31mred\u001b[0m text\u001b[2K'), 'red text');
    assert.strictEqual(stripAnsi('a\u001b[1;38;5;196mb'), 'ab');
  });
  it('removes OSC sequences ended by BEL or ST', () => {
    assert.strictEqual(stripAnsi('x\u001b]0;title\u0007y'), 'xy');
    assert.strictEqual(stripAnsi('x\u001b]8;;http://a\u001b\\y'), 'xy');
  });
  it('leaves plain text untouched, including a lone ESC-less bracket', () => {
    assert.strictEqual(stripAnsi('[31m not an escape'), '[31m not an escape');
    assert.strictEqual(stripAnsi(''), '');
  });
});

describe('controlGlyphs', () => {
  it('shows NUL and other C0 controls as control pictures', () => {
    assert.strictEqual(controlGlyphs('a\u0000b'), 'a␀b');
    assert.strictEqual(controlGlyphs('\u0007'), '␇');
    assert.strictEqual(controlGlyphs('\u007f'), '␡');
  });
  it('expands tabs and replaces C1 and separators', () => {
    assert.strictEqual(controlGlyphs('a\tb'), 'a    b');
    assert.strictEqual(controlGlyphs('\u0085 '), '��');
  });
  it('keeps newlines only on request', () => {
    assert.strictEqual(controlGlyphs('a\nb\r'), 'a␊b␍');
    assert.strictEqual(controlGlyphs('a\nb\r', true), 'a\nb\r');
  });
});

describe('sanitizeField', () => {
  it('removes control characters and cuts to the limit', () => {
    assert.strictEqual(sanitizeField('a\u0000b\nc\u007f'), 'abc');
    assert.strictEqual(sanitizeField('x'.repeat(600)).length, 512);
    assert.strictEqual(sanitizeField('abcdef', 3), 'abc');
  });
});
