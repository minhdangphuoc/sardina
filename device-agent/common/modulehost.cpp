#include "modulehost.h"
#include "childlink.h"
#include "signalpipe.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QLocalSocket>
#include <csignal>
#include <cstdio>
#include <fcntl.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {

const int CLIENT_FD = 3;
const int FINISH_WRITE_MS = 2000;

bool isSocket(int fd)
{
    struct stat st;
    return fstat(fd, &st) == 0 && S_ISSOCK(st.st_mode);
}

bool isPipe(int fd)
{
    struct stat st;
    return fstat(fd, &st) == 0 && S_ISFIFO(st.st_mode);
}

}

ModuleHost::ModuleHost(const char *module, bool needsSocket, QObject *parent)
    : QObject(parent)
    , m_module(QLatin1String(module))
    , m_needsSocket(needsSocket)
    , m_started(false)
    , m_finished(false)
    , m_link(nullptr)
    , m_socket(nullptr)
{
}

int ModuleHost::init(const QStringList &args)
{
    const QString name = QStringLiteral("sailfish-devagent-") + m_module;
    if (args.size() == 2 && args.at(1) == QLatin1String("--version")) {
        printf("%s\n", AGENT_VERSION);
        return 0;
    }
    // Only the daemon starts a module: run by hand, it refuses rather than serve a terminal.
    if (args.size() != 2 || args.at(1) != QLatin1String("--serve") || !isPipe(0) || !isPipe(1)
        || (m_needsSocket && !isSocket(CLIENT_FD))) {
        fprintf(stderr, "%s: started by sailfish-devagent only\n", qPrintable(name));
        return 2;
    }
    prctl(PR_SET_PDEATHSIG, SIGTERM);
    if (getppid() == 1) {
        return 1; // the parent died before the line above
    }
    // Events get their own descriptor; anything printed to stdout by mistake goes nowhere.
    const int eventFd = fcntl(1, F_DUPFD_CLOEXEC, 10);
    const int devNull = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (eventFd < 0 || devNull < 0 || dup2(devNull, 1) < 0) {
        return 1;
    }
    close(devNull);
    const int controlFd = fcntl(0, F_DUPFD_CLOEXEC, 10);
    close(0);
    m_link = new LineLink(controlFd, eventFd, this);
    connect(m_link, &LineLink::received, this, &ModuleHost::onControl);
    connect(m_link, &LineLink::closed, this, &ModuleHost::onDaemonGone);
    if (m_needsSocket) {
        // Grandchildren (journalctl) must not inherit the client's socket.
        fcntl(CLIENT_FD, F_SETFD, FD_CLOEXEC);
        m_socket = new QLocalSocket(this);
        if (!m_socket->setSocketDescriptor(CLIENT_FD, QLocalSocket::ConnectedState, QIODevice::ReadWrite)) {
            fprintf(stderr, "%s: cannot use the client socket: %s\n", qPrintable(name),
                    qPrintable(m_socket->errorString()));
            return 1;
        }
    }
    SignalPipe *signalPipe = new SignalPipe(QList<int>() << SIGTERM << SIGINT, this);
    connect(signalPipe, &SignalPipe::received, qApp, &QCoreApplication::quit);
    signal(SIGPIPE, SIG_IGN);
    return -1;
}

void ModuleHost::sendEvent(const QJsonObject &event)
{
    if (m_link) {
        m_link->send(event);
    }
}

void ModuleHost::finish(const QString &reason)
{
    if (m_finished) {
        return;
    }
    m_finished = true;
    if (m_socket && m_socket->state() != QLocalSocket::UnconnectedState) {
        QElapsedTimer clock;
        clock.start();
        while (m_socket->bytesToWrite() > 0 && clock.elapsed() < FINISH_WRITE_MS
               && m_socket->waitForBytesWritten(FINISH_WRITE_MS - static_cast<int>(clock.elapsed()))) {
        }
    }
    QJsonObject ended;
    ended.insert(QStringLiteral("ended"), reason);
    sendEvent(ended);
    if (m_link) {
        m_link->flush(FINISH_WRITE_MS);
    }
    QCoreApplication::exit(0);
}

void ModuleHost::onControl(const QJsonObject &line)
{
    if (!m_started) {
        m_started = true;
        emit started(line);
        return;
    }
    const QJsonValue end = line.value(QStringLiteral("end"));
    if (end.isString()) {
        emit endRequested(end.toString());
        return;
    }
    emit control(line);
}

void ModuleHost::onDaemonGone()
{
    QCoreApplication::exit(0);
}
