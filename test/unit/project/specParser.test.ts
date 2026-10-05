import * as assert from 'assert';
import { parseSpec } from '../../../src/project/specParser';

const QMAKE_SPEC = `
Name:       harbour-demo
Summary:    Demo Sailfish OS application
Version:    0.1
Release:    1
Requires:   sailfishsilica-qt5 >= 0.10.9
BuildRequires: pkgconfig(sailfishapp) >= 1.0.2
BuildRequires: pkgconfig(Qt5Qml)

%description
%{summary}.

%files
%defattr(-,root,root,-)
%{_bindir}/%{name}
%{_datadir}/%{name}/qml
`;

const CMAKE_SPEC = `
Name:       harbour-cmake-demo
Version:    0.1
Requires:   sailfishsilica-qt5 >= 0.10.9
BuildRequires: cmake >= 3.10

%files
%{_bindir}/%{name}
`;

const PURE_QML_SPEC = `
Name:       harbour-pureqml
Version:    0.1
Requires:   sailfish-qml

%files
%{_datadir}/%{name}/qml
%{_datadir}/applications/%{name}.desktop
`;

const UNUSUAL_MACROS_SPEC = `
Name:       harbour-macro-demo
Version:    2.0
Release:    %{?dist}
Summary:    Uses %{undefined_macro} and %{name}-%{version} together
Requires:   sailfishsilica-qt5

%files
%{_bindir}/%{name}
%{_prefix}/lib/%{name}/plugin.so
`;

const SUBPACKAGE_SPEC = `
Name:       harbour-demo
Version:    0.1
Release:    1
Summary:    Demo Sailfish OS application
Requires:   sailfishsilica-qt5 >= 0.10.9

%description
This is the main package. Version: 9.9 in prose should not leak.

%package devel
Summary: Development files
Version: 9.9

%description devel
Version: 9.9 in prose

%files
%{_bindir}/%{name}
`;

describe('parseSpec', () => {
  it('keeps main-package Name/Version/Release/Summary despite subpackage and prose lines (FR-2.4)', () => {
    const info = parseSpec(SUBPACKAGE_SPEC, { hasCMakeLists: false, hasProFile: true });
    assert.strictEqual(info.name, 'harbour-demo');
    assert.strictEqual(info.version, '0.1');
    assert.strictEqual(info.release, '1');
    assert.strictEqual(info.summary, 'Demo Sailfish OS application');
    assert.strictEqual(info.hasNativeBinary, true);
  });

  it('parses a qmake app: native binary, not pure-QML, buildSystem qmake', () => {
    const info = parseSpec(QMAKE_SPEC, { hasCMakeLists: false, hasProFile: true });
    assert.strictEqual(info.name, 'harbour-demo');
    assert.strictEqual(info.version, '0.1');
    assert.strictEqual(info.release, '1');
    assert.strictEqual(info.summary, 'Demo Sailfish OS application');
    assert.deepStrictEqual(info.buildRequires, ['pkgconfig(sailfishapp) >= 1.0.2', 'pkgconfig(Qt5Qml)']);
    assert.strictEqual(info.hasNativeBinary, true);
    assert.strictEqual(info.isPureQml, false);
    assert.strictEqual(info.buildSystem, 'qmake');
  });

  it('parses a cmake app: buildSystem cmake wins over an incidental *.pro', () => {
    const info = parseSpec(CMAKE_SPEC, { hasCMakeLists: true, hasProFile: true });
    assert.strictEqual(info.buildSystem, 'cmake');
    assert.strictEqual(info.hasNativeBinary, true);
  });

  it('parses a pure-QML app: no native binary, isPureQml true', () => {
    const info = parseSpec(PURE_QML_SPEC, { hasCMakeLists: false, hasProFile: true });
    assert.strictEqual(info.hasNativeBinary, false);
    assert.strictEqual(info.isPureQml, true);
  });

  it('expands %{name}/%{version} but leaves other macros verbatim', () => {
    const info = parseSpec(UNUSUAL_MACROS_SPEC, { hasCMakeLists: false, hasProFile: false });
    assert.strictEqual(info.name, 'harbour-macro-demo');
    assert.strictEqual(info.summary, 'Uses %{undefined_macro} and harbour-macro-demo-2.0 together');
    assert.strictEqual(info.release, '%{?dist}');
    assert.strictEqual(info.hasNativeBinary, true);
    assert.strictEqual(info.buildSystem, 'unknown');
  });

  it('never throws on an empty file and returns a safe default', () => {
    const info = parseSpec('', { hasCMakeLists: false, hasProFile: false });
    assert.strictEqual(info.name, '');
    assert.strictEqual(info.hasNativeBinary, false);
    assert.strictEqual(info.isPureQml, false);
    assert.strictEqual(info.buildSystem, 'unknown');
    assert.deepStrictEqual(info.buildRequires, []);
  });

  it('never throws on garbage input', () => {
    assert.doesNotThrow(() => parseSpec('\0\0\0 not a spec file at all {{{', { hasCMakeLists: false, hasProFile: false }));
  });

  describe('native binary detection in %files', () => {
    const spec = (files: string) => `Name: harbour-x\nVersion: 1\n\n%files\n${files}\n`;

    it('recognises the bare %{_bindir} entry the stock Sailfish app template uses', () => {
      assert.strictEqual(parseSpec(spec('%defattr(-,root,root,-)\n%{_datadir}/%{name}/qml\n%{_bindir}'), { hasProFile: true, hasCMakeLists: false }).hasNativeBinary, true);
    });

    it('recognises %{_bindir}/*, /usr/bin and an attr-prefixed entry', () => {
      for (const files of ['%{_bindir}/*', '/usr/bin', '/usr/bin/%{name}', '%attr(755,root,root) %{_bindir}/%{name}']) {
        assert.strictEqual(parseSpec(spec(files), { hasProFile: true, hasCMakeLists: false }).hasNativeBinary, true, files);
      }
    });

    it('does not treat another binary or a longer path as this app\'s binary', () => {
      for (const files of ['%{_bindir}/other-tool', '%{_bindir}/%{name}-helper', '%{_datadir}/%{name}/bin', '%{_bindirx}']) {
        assert.strictEqual(parseSpec(spec(files), { hasProFile: true, hasCMakeLists: false }).hasNativeBinary, false, files);
      }
    });
  });
});
