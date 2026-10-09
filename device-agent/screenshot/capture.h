#ifndef CAPTURE_H
#define CAPTURE_H

#include <QObject>
#include <QString>
#include <QTimer>

class QDBusPendingCallWatcher;

// One lipstick screen capture: creates the staging folder, asks lipstick (the compositor) over the
// session bus, without blocking, to save the screen to stagingPath (lipstick only accepts paths under
// home), then polls until the file exists, is not empty and its size stopped changing. On success the
// file is left in place for the caller; on failure it is removed and the staging folder is rmdir'd if
// empty.
class Capture : public QObject
{
    Q_OBJECT
public:
    Capture(const QString &stagingPath, int timeoutMs, QObject *parent = nullptr);

    void start();

signals:
    // Empty error means the file at stagingPath is complete.
    void finished(const QString &error);

private slots:
    void onCallFinished(QDBusPendingCallWatcher *watcher);
    void poll();

private:
    void fail(const QString &message);

    QString m_stagingPath;
    QTimer m_poll;
    int m_polls;
    int m_pollMax;
    qint64 m_lastSize;
};

#endif
