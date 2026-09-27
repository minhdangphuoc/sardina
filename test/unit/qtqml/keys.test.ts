import * as assert from 'assert';
import {
  QT_QML_ADDITIONAL_IMPORT_PATHS_KEY,
  QT_QML_CUSTOM_EXE_PATH_KEY,
  QT_QML_DO_NOT_ASK_KEY,
  QT_QML_ENABLED_KEY,
  QT_QML_EXTENSION_ID,
  QT_QML_SECTION,
} from '../../../src/qtqml/keys';

/** NFR-14/§2.2: the single constants file holding the qt-qml section and its four settings keys. */
describe('qtqml/keys (NFR-14, §2.2)', () => {
  it('declares the qt-qml section and extension id', () => {
    assert.strictEqual(QT_QML_SECTION, 'qt-qml');
    assert.strictEqual(QT_QML_EXTENSION_ID, 'theqtcompany.qt-qml');
  });

  it('declares all four §2.2 settings keys', () => {
    assert.strictEqual(QT_QML_ENABLED_KEY, 'qmlls.enabled');
    assert.strictEqual(QT_QML_DO_NOT_ASK_KEY, 'doNotAskForQmllsDownload');
    assert.strictEqual(QT_QML_CUSTOM_EXE_PATH_KEY, 'qmlls.customExePath');
    assert.strictEqual(QT_QML_ADDITIONAL_IMPORT_PATHS_KEY, 'qmlls.additionalImportPaths');
  });
});
