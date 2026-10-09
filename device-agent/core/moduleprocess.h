#ifndef MODULEPROCESS_H
#define MODULEPROCESS_H

#include <QJsonObject>
#include <QObject>
#include <QString>
#include <sys/types.h>

class LineLink;

// The daemon's side of one running module process: its control and event lines and its exit.
class ModuleProcess : public QObject
{
    Q_OBJECT
public:
    // Spawns `module` with `clientFd` as its fd 3 (the caller keeps and closes its own copy) and
    // sends `control` as the first line. Null and `error` set when it cannot start.
    static ModuleProcess *start(const QString &module, int clientFd, const QJsonObject &control,
                                const QString &client, QString *error, QObject *parent);
    ~ModuleProcess();

    QString module() const { return m_module; }
    QString client() const { return m_client; }
    // The last {"status":{...}} it reported (the mirror's state for the Settings page).
    QJsonObject status() const { return m_status; }
    // An "end" was sent (it is ending, but may not have exited yet).
    bool ending() const { return m_ending; }
    // It started the stream indicator and has not stopped it (the mirror).
    bool indicated() const { return m_indicated; }
    void setIndicated(bool on) { m_indicated = on; }

    void send(const QJsonObject &line);
    // Asks the module to end its stream with `reason` (sent to the client).
    void end(const QString &reason);
    // SIGTERM: ends without a word to the client (the daemon stops).
    void terminate();
    void kill();
    // Collects the exit status when it has exited; true then (once).
    bool reap();

signals:
    void event(ModuleProcess *process, const QJsonObject &line);

private:
    ModuleProcess(const QString &module, const QString &client, pid_t pid, QObject *parent);
    void onEvent(const QJsonObject &line);

    QString m_module;
    QString m_client;
    pid_t m_pid;
    LineLink *m_link;
    QJsonObject m_status;
    bool m_ending;
    bool m_indicated;
};

#endif
