import * as assert from 'node:assert';
import { hasWhitespace, whitespacePathWarning } from '../../../src/tasks/pathGuard';

describe('pathGuard', () => {
  it('accepts a path without whitespace', () => {
    assert.strictEqual(hasWhitespace('/home/jane/Work/Projects/cameragallery'), false);
    assert.strictEqual(whitespacePathWarning('/home/jane/Work/Projects/cameragallery'), undefined);
  });

  it('flags a space inside a folder name', () => {
    assert.strictEqual(hasWhitespace('/home/jane/My Projects/app'), true);
  });

  it('flags a trailing space in a folder name', () => {
    const warning = whitespacePathWarning('/home/jane/Work/Projects /cameragallery');
    assert.ok(warning?.includes('/home/jane/Work/Projects /cameragallery'));
    assert.ok(warning?.includes('whitespace'));
  });

  it('flags tabs and newlines too', () => {
    assert.strictEqual(hasWhitespace('/home/jane/a\tb'), true);
    assert.strictEqual(hasWhitespace('/home/jane/a\nb'), true);
  });
});
