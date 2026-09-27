import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Compiled to out/test/unit/snippets/*.js (tsc rootDir mirrors the source tree).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SNIPPETS_PATH = path.join(REPO_ROOT, 'snippets', 'silica.code-snippets');

const REQUIRED_PREFIXES = [
  'sfpage',
  'sfdialog',
  'sflistview',
  'sfflickable',
  'sfpulldown',
  'sfpushup',
  'sfcover',
  'sfremorseitem',
  'sfremorsepopup',
  'sfbutton',
  'sftextfield',
  'sfswitch',
  'sfslider',
  'sfcombobox',
  'sfsectionheader',
  'sfdetailitem',
  'sfbusy',
  'sfviewplaceholder',
  'sfappwindow',
  'sfattached',
  'sfnotification',
];

// R9/NFR-15: a Silica property/method/signal/enum list or doc string is
// proprietary; bare type names are not. This is a coarse denylist for
// obviously-copied documentation shapes, not a full proprietary-data check
// (that is scripts/check-proprietary.mjs, run separately in the gate).
const DENYLISTED_PATTERNS = [/jolla/i, /sailfishos\.org\/(silica|reference)/i, /\bmember of\b/i, /@qmlproperty/i];

interface SnippetDefinition {
  prefix: string;
  body: string[];
  description: string;
}

function loadSnippets(): Record<string, SnippetDefinition> {
  const raw = fs.readFileSync(SNIPPETS_PATH, 'utf8');
  return JSON.parse(raw) as Record<string, SnippetDefinition>;
}

describe('snippets/silica.code-snippets (FR-8.2, AC-1.11)', () => {
  it('parses as JSON', () => {
    assert.doesNotThrow(() => loadSnippets());
  });

  it('defines every FR-8.2 prefix with a non-empty body and a description', () => {
    const snippets = loadSnippets();
    const byPrefix = new Map(Object.values(snippets).map((s) => [s.prefix, s]));

    for (const prefix of REQUIRED_PREFIXES) {
      const snippet = byPrefix.get(prefix);
      assert.ok(snippet, `missing snippet for prefix "${prefix}"`);
      assert.ok(Array.isArray(snippet?.body) && (snippet?.body.length ?? 0) > 0, `prefix "${prefix}" has an empty body`);
      assert.ok(typeof snippet?.description === 'string' && snippet.description.length > 0, `prefix "${prefix}" has no description`);
    }
  });

  it('has no duplicate prefixes', () => {
    const snippets = loadSnippets();
    const prefixes = Object.values(snippets).map((s) => s.prefix);
    assert.strictEqual(new Set(prefixes).size, prefixes.length, 'duplicate snippet prefixes found');
  });

  it('bodies contain at least one tabstop and no denylisted documentation-shaped text', () => {
    const snippets = loadSnippets();
    for (const [name, snippet] of Object.entries(snippets)) {
      const bodyText = snippet.body.join('\n');
      assert.ok(/\$\{?\d/.test(bodyText), `snippet "${name}" has no $n/\${n:...} tabstop`);
      for (const pattern of DENYLISTED_PATTERNS) {
        assert.ok(!pattern.test(bodyText) && !pattern.test(snippet.description), `snippet "${name}" matches denylisted pattern ${pattern}`);
      }
    }
  });
});
