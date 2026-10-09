/**
 * TRD §2.2/NFR-14 — the qt-qml extension id plus every settings key this
 * extension reads or writes on it. Kept as bare string constants; no Silica
 * property/method/doc data (NFR-15). silence.ts takes its key strings only
 * from here.
 */
export const QT_QML_EXTENSION_ID = 'theqtcompany.qt-qml';
export const QT_QML_LANGUAGE_ID = 'qml';
export const QT_QML_SILENCE_SETTING = 'sardina.qtqml.silenceQmlls';

/** `getConfiguration(QT_QML_SECTION, folder.uri)` — never read/written at any other scope than WorkspaceFolder. */
export const QT_QML_SECTION = 'qt-qml';
export const QT_QML_ENABLED_KEY = 'qmlls.enabled';
export const QT_QML_DO_NOT_ASK_KEY = 'doNotAskForQmllsDownload';
export const QT_QML_CUSTOM_EXE_PATH_KEY = 'qmlls.customExePath';
export const QT_QML_ADDITIONAL_IMPORT_PATHS_KEY = 'qmlls.additionalImportPaths';

/** globalState flag: the missing-qt-qml recommendation is shown at most once, ever. */
export const QT_QML_MISSING_NOTICE_FLAG = 'sardina.qtqml.missingNoticeShown';
