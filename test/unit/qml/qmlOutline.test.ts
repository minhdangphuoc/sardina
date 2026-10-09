import * as assert from "assert";
import {
  contextAt,
  findObjectAt,
  parseQmlOutline,
  toComponentOutline,
} from "../../../src/qml/qmlOutline";

const names = (o: { members: { name: string }[] }) =>
  o.members.map((m) => m.name);

describe("qml/qmlOutline", () => {
  it("reads module, directory and JS imports", () => {
    const o = parseQmlOutline(
      'import QtQuick 2.0\nimport Fx.Widgets 1.2 as W\nimport "../lib"\nimport "util.js" as U\npragma Singleton\nItem {}\n',
    );
    assert.deepStrictEqual(
      o.imports.map(({ kind, module, version, qualifier, path }) => ({
        kind,
        module,
        version,
        qualifier,
        path,
      })),
      [
        {
          kind: "module",
          module: "QtQuick",
          version: "2.0",
          qualifier: undefined,
          path: undefined,
        },
        {
          kind: "module",
          module: "Fx.Widgets",
          version: "1.2",
          qualifier: "W",
          path: undefined,
        },
        {
          kind: "dir",
          module: undefined,
          version: undefined,
          qualifier: undefined,
          path: "../lib",
        },
        {
          kind: "js",
          module: undefined,
          version: undefined,
          qualifier: "U",
          path: "util.js",
        },
      ],
    );
    assert.strictEqual(o.imports[1].range.start.line, 1);
    assert.strictEqual(o.root?.typeName, "Item");
    assert.ok(o.clean);
  });

  it("builds nested objects with ranges, qualified names and group properties", () => {
    const text =
      "import Q 1.0 as Q\nQ.Box {\n  anchors { left: parent.left }\n  Item {\n    Q.Leaf {}\n  }\n}\n";
    const o = parseQmlOutline(text);
    const root = o.root!;
    assert.strictEqual(root.typeName, "Q.Box");
    assert.deepStrictEqual(
      root.children.map((c) => c.typeName),
      ["anchors", "Item"],
    );
    assert.strictEqual(root.children[1].children[0].typeName, "Q.Leaf");
    assert.strictEqual(root.range.start.offset, text.indexOf("Q.Box"));
    assert.strictEqual(root.range.end.offset, text.lastIndexOf("}") + 1);
    assert.deepStrictEqual(
      [
        root.range.start.line,
        root.range.start.col,
        root.range.end.line,
        root.range.end.col,
      ],
      [1, 0, 6, 1],
    );
    assert.deepStrictEqual(names(root.children[0]), ["left"]);
  });

  it("reads declarations and assignments", () => {
    const o = parseQmlOutline(`Item {
  property int a: 1
  readonly property string b: "x"
  default property list<Item> kids
  property alias c: inner.text
  property var v
  signal pressed(int x, string y)
  signal plain
  function go(p, q) { return p + q }
  anchors.fill: parent
  onClicked: { go(1, 2) }
  width: 10; height: 20
  Text { id: inner }
}`);
    const m = o.root!.members;
    assert.deepStrictEqual(
      m.map((x) => [x.kind, x.name, x.type]),
      [
        ["property", "a", "int"],
        ["property", "b", "string"],
        ["property", "kids", "list<Item>"],
        ["alias", "c", undefined],
        ["property", "v", "var"],
        ["signal", "pressed", undefined],
        ["signal", "plain", undefined],
        ["method", "go", undefined],
        ["binding", "anchors.fill", undefined],
        ["binding", "onClicked", undefined],
        ["binding", "width", undefined],
        ["binding", "height", undefined],
      ],
    );
    assert.ok(m[1].readonly && m[2].isDefault);
    assert.deepStrictEqual(m[5].params, ["x", "y"]);
    assert.deepStrictEqual(m[7].params, ["p", "q"]);
    assert.strictEqual(o.root!.children.length, 1);
    assert.strictEqual(m[8].range.start.line, 9);
    assert.ok(o.clean);
  });

  it("records ids with their object type at any depth", () => {
    const o = parseQmlOutline(
      'Page {\n id: page\n Column {\n  Label { id: lbl }\n  Q.Button { id: btn; text: "x" }\n }\n}',
    );
    assert.deepStrictEqual(
      o.ids.map((i) => [i.id, i.typeName]),
      [
        ["page", "Page"],
        ["lbl", "Label"],
        ["btn", "Q.Button"],
      ],
    );
    assert.strictEqual(o.root!.id, "page");
  });

  it("keeps multi-line bindings together and objects in lists and bindings", () => {
    const o = parseQmlOutline(`Item {
  x: a +
     b
  y: cond
     ? 1 : 2
  delegate: Rectangle { id: r }
  items: [ Item { id: i1 }, Item { id: i2 } ]
  Behavior on x { NumberAnimation {} }
  z: 3
}`);
    assert.deepStrictEqual(names(o.root!), [
      "x",
      "y",
      "delegate",
      "items",
      "z",
    ]);
    assert.deepStrictEqual(
      o.root!.children.map((c) => [c.typeName, c.assignedTo, c.onProperty]),
      [
        ["Rectangle", "delegate", undefined],
        ["Item", "items", undefined],
        ["Item", "items", undefined],
        ["Behavior", undefined, "x"],
      ],
    );
    assert.deepStrictEqual(
      o.ids.map((i) => i.id),
      ["r", "i1", "i2"],
    );
  });

  it("ignores braces, colons and keywords in strings, templates, regexes and comments", () => {
    const o = parseQmlOutline(
      String.raw`Item {
  // } Fake { id: no
  /* } property int ghost */
  a: "}{ \" Item {"
  b: '}'
  c: ` +
        '`${ "}" + `{${1}` } }`' +
        String.raw`
  d: /[}]\/{/.test(x) ? 1 : 2
  e: total / 2 / 4
  f: { var o = { k: 1 }; if (o) { return "}" } }
  Item { id: inner }
}
Trailing {`,
    );
    assert.deepStrictEqual(names(o.root!), ["a", "b", "c", "d", "e", "f"]);
    assert.deepStrictEqual(
      o.ids.map((i) => i.id),
      ["inner"],
    );
    assert.ok(o.clean);
  });

  it("flags unbalanced input as not clean and still returns what it saw", () => {
    for (const text of [
      "Item {\n  Rectangle { id: r\n",
      'Item { a: "open\n b: 1 }',
      "Item { /* open",
      "Item { a: `open",
      "Item { a: (1 }",
      "Item { } }",
    ]) {
      const o = parseQmlOutline(text);
      assert.strictEqual(o.root?.typeName, "Item", text);
      if (text !== "Item { } }") assert.strictEqual(o.clean, false, text);
    }
    const o = parseQmlOutline("Item {\n  Rectangle { id: r\n");
    assert.strictEqual(o.root!.children[0].typeName, "Rectangle");
    assert.strictEqual(
      o.root!.range.end.offset,
      "Item {\n  Rectangle { id: r\n".length,
    );
    assert.deepStrictEqual(
      o.ids.map((i) => i.id),
      ["r"],
    );
  });

  it("handles empty and non-QML input", () => {
    assert.strictEqual(parseQmlOutline("").root, undefined);
    assert.strictEqual(parseQmlOutline("").clean, true);
    assert.doesNotThrow(() => parseQmlOutline('}}}{{{ ((( ]]] ::: "'));
    assert.doesNotThrow(() => parseQmlOutline("Item {".repeat(5000)));
  });

  describe("findObjectAt and contextAt", () => {
    const text =
      "import QtQuick 2.0\nItem {\n  id: root\n  width: parent.\n  Rectangle {\n    \n  }\n  // note.\n}\n";
    const o = parseQmlOutline(text);
    const at = (needle: string, delta = 0) => text.indexOf(needle) + delta;

    it("finds the innermost object", () => {
      assert.strictEqual(
        findObjectAt(o, at("Rectangle {\n    \n", "Rectangle {\n    ".length))
          ?.typeName,
        "Rectangle",
      );
      assert.strictEqual(findObjectAt(o, at("id: root"))?.typeName, "Item");
      assert.strictEqual(findObjectAt(o, 3), undefined);
    });

    it("classifies import, body, value, after-dot, top and opaque positions", () => {
      assert.deepStrictEqual(contextAt(o, text, at("QtQuick", 3)), {
        kind: "import",
        prefix: "QtQ",
      });
      const body = contextAt(
        o,
        text,
        at("Rectangle {\n    \n", "Rectangle {\n    ".length),
      );
      assert.ok(
        body.kind === "body" &&
          body.object.typeName === "Rectangle" &&
          body.partial === "",
      );
      const dot = contextAt(o, text, at("parent.") + "parent.".length);
      assert.ok(
        dot.kind === "afterDot" &&
          dot.target === "parent" &&
          dot.partial === "" &&
          dot.object?.typeName === "Item",
      );
      const val = contextAt(o, text, at("parent."));
      assert.ok(val.kind === "value" && val.member.name === "width");
      assert.strictEqual(contextAt(o, text, 0).kind, "top");
      assert.strictEqual(contextAt(o, text, at("// note.") + 4).kind, "none");
    });

    it("treats a name typed in a body as a partial", () => {
      const t = "Item {\n  wid\n}";
      const c = contextAt(parseQmlOutline(t), t, t.indexOf("wid") + 3);
      assert.ok(c.kind === "body" && c.partial === "wid");
    });

    it("sees an empty value after the colon", () => {
      const t = "Item {\n  width: \n}";
      const c = contextAt(parseQmlOutline(t), t, t.indexOf(": ") + 2);
      assert.ok(c.kind === "value" && c.member.name === "width");
    });
  });

  it("adapts the root to a component outline", () => {
    const o = parseQmlOutline(
      'import QtQuick 2.0\nimport "d"\nQ.Item {\n property int n\n property alias a: x.y\n signal s(int v)\n function f(p) {}\n width: 1\n}',
    );
    assert.deepStrictEqual(toComponentOutline(o), {
      rootType: "Q.Item",
      imports: [{ module: "QtQuick", version: "2.0" }, { path: "d" }],
      members: [
        { kind: "property", name: "n", type: "int" },
        { kind: "alias", name: "a" },
        { kind: "signal", name: "s", params: ["v"] },
        { kind: "method", name: "f", params: ["p"] },
      ],
    });
    assert.deepStrictEqual(toComponentOutline(parseQmlOutline("")), {
      rootType: "",
      imports: [],
      members: [],
    });
  });
});
