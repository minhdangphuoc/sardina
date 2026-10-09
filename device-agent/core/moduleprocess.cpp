#include "moduleprocess.h"
#include "childlink.h"
#include "modules.h"

#include <csignal>
#include <cstdio>

ModuleProcess *ModuleProcess::start(const QString &module, int clientFd, const QJsonObject &control,
                                    const QString &client, QString *error, QObject *parent)
{
    ChildLink::Child child;
    if (!ChildLink::spawn(Modules::executable(module).toLocal8Bit(), QList<QByteArray>() << QByteArrayLiteral("--serve"),
                          clientFd, &child, error)) {
        return nullptr;
    }
    ModuleProcess *process = new ModuleProcess(module, client, child.pid, parent);
    process->m_link = new LineLink(child.eventFd, child.controlFd, process);
    connect(process->m_link, &LineLink::received, process, &ModuleProcess::onEvent);
    process->send(control);
    fprintf(stderr, "sailfish-devagent: %s module started (pid %d)\n", qPrintable(module), static_cast<int>(child.pid));
    return process;
}

ModuleProcess::ModuleProcess(const QString &module, const QString &client, pid_t pid, QObject *parent)
    : QObject(parent)
    , m_module(module)
    , m_client(client)
    , m_pid(pid)
    , m_link(nullptr)
    , m_ending(false)
    , m_indicated(false)
{
}

ModuleProcess::~ModuleProcess()
{
    if (m_pid > 0) {
        ::kill(m_pid, SIGKILL); // never left running unreaped; reap() below collects it
        ChildLink::reap(m_pid);
    }
}

void ModuleProcess::send(const QJsonObject &line)
{
    m_link->send(line);
}

void ModuleProcess::end(const QString &reason)
{
    m_ending = true;
    QJsonObject line;
    line.insert(QStringLiteral("end"), reason);
    send(line);
}

void ModuleProcess::terminate()
{
    if (m_pid > 0) {
        ::kill(m_pid, SIGTERM);
    }
}

void ModuleProcess::kill()
{
    if (m_pid > 0) {
        ::kill(m_pid, SIGKILL);
    }
}

bool ModuleProcess::reap()
{
    if (m_pid <= 0 || !ChildLink::reap(m_pid)) {
        return false;
    }
    fprintf(stderr, "sailfish-devagent: %s module ended (pid %d)\n", qPrintable(m_module), static_cast<int>(m_pid));
    m_pid = -1;
    return true;
}

void ModuleProcess::onEvent(const QJsonObject &line)
{
    const QJsonValue status = line.value(QStringLiteral("status"));
    if (status.isObject()) {
        m_status = status.toObject();
    }
    emit event(this, line);
}
