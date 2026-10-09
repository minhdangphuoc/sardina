#ifndef SCREENSHOT_H
#define SCREENSHOT_H

#include <QObject>
#include <QJsonObject>
#include <QString>

// Asks lipstick (the compositor) to save a screenshot into a staging folder under home (lipstick
// refuses other paths) through Capture, moves the file into the agent's runtime directory and
// reports that path.
class Screenshot : public QObject
{
    Q_OBJECT
public:
    explicit Screenshot(QObject *parent = nullptr);

    void take();

signals:
    void finished(const QJsonObject &result);

private slots:
    void onCaptured(const QString &error);

private:
    void fail(const QString &message);

    QString m_path;        // final path, in the agent's runtime directory (returned to the client)
    QString m_stagingPath; // where lipstick writes it (lipstick only accepts paths under home)
};

#endif
