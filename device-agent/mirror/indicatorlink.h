#ifndef INDICATORLINK_H
#define INDICATORLINK_H

#include <QJsonObject>
#include <QObject>

class ModuleHost;

// The mirror's side of the daemon's stream indicator (the "Screen is being viewed/controlled"
// entry): the same calls MirrorStream made on StreamIndicator, sent as event lines. Control stays
// off until the daemon reports that the "controlled" text is shown.
class IndicatorLink : public QObject
{
    Q_OBJECT
public:
    explicit IndicatorLink(ModuleHost *host, QObject *parent = nullptr);

    void streamStarted();
    void streamStopped();
    // True when the entry already says "controlled" (or when deactivating).
    bool setInputActive(bool active);
    // A control line from the daemon: {"indicator":{"inputShown":bool}}.
    void handle(const QJsonObject &indicator);

signals:
    // The "controlled" entry is shown while input is still wanted.
    void inputReady();

private:
    void send(const QJsonValue &value);

    ModuleHost *m_host;
    bool m_wantInput;
    bool m_inputShown;
};

#endif
