#include "childlink.h"

#include <QElapsedTimer>
#include <QJsonDocument>
#include <QPointer>
#include <QSocketNotifier>
#include <QVector>

#include <cerrno>
#include <csignal>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

namespace ChildLink {

namespace {

void closeFd(int &fd)
{
    if (fd >= 0) {
        close(fd);
        fd = -1;
    }
}

QVector<char *> argv(const QByteArray &exe, const QList<QByteArray> &args)
{
    QVector<char *> out;
    out << const_cast<char *>(exe.constData());
    for (const QByteArray &arg : args) {
        out << const_cast<char *>(arg.constData());
    }
    out << nullptr;
    return out;
}

}

bool spawn(const QByteArray &exe, const QList<QByteArray> &args, int handoffFd, Child *child, QString *error)
{
    int control[2] = { -1, -1 };
    int events[2] = { -1, -1 };
    if (pipe2(control, O_CLOEXEC) != 0 || pipe2(events, O_CLOEXEC) != 0) {
        *error = QStringLiteral("pipe: ") + QString::fromLocal8Bit(strerror(errno));
        closeFd(control[0]);
        closeFd(control[1]);
        return false;
    }
    // A descriptor already at 0, 1 or 3 would keep close-on-exec through a no-op dup2.
    int handoff = handoffFd >= 0 ? fcntl(handoffFd, F_DUPFD_CLOEXEC, 10) : -1;
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    // dup2 clears close-on-exec on the target, so only these descriptors reach the child.
    posix_spawn_file_actions_adddup2(&actions, control[0], 0);
    posix_spawn_file_actions_adddup2(&actions, events[1], 1);
    if (handoff >= 0) {
        posix_spawn_file_actions_adddup2(&actions, handoff, 3);
    }
    posix_spawnattr_t attr;
    posix_spawnattr_init(&attr);
    // The daemon ignores SIGPIPE; a module starts with the default dispositions and an empty mask.
    sigset_t defaults;
    sigemptyset(&defaults);
    sigaddset(&defaults, SIGPIPE);
    sigaddset(&defaults, SIGTERM);
    sigaddset(&defaults, SIGINT);
    sigaddset(&defaults, SIGCHLD);
    sigset_t none;
    sigemptyset(&none);
    posix_spawnattr_setsigdefault(&attr, &defaults);
    posix_spawnattr_setsigmask(&attr, &none);
    posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK);
    QVector<char *> arguments = argv(exe, args);
    pid_t pid = -1;
    const int rc = posix_spawn(&pid, exe.constData(), &actions, &attr, arguments.data(), environ);
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attr);
    closeFd(control[0]);
    closeFd(events[1]);
    closeFd(handoff);
    if (rc != 0) {
        *error = QString::fromLocal8Bit(strerror(rc));
        closeFd(control[1]);
        closeFd(events[0]);
        return false;
    }
    fcntl(control[1], F_SETFL, fcntl(control[1], F_GETFL) | O_NONBLOCK);
    fcntl(events[0], F_SETFL, fcntl(events[0], F_GETFL) | O_NONBLOCK);
    child->pid = pid;
    child->controlFd = control[1];
    child->eventFd = events[0];
    return true;
}

bool capture(const QByteArray &exe, const QList<QByteArray> &args, int timeoutMs, QByteArray *out)
{
    Child child;
    QString error;
    if (!spawn(exe, args, -1, &child, &error)) {
        return false;
    }
    closeFd(child.controlFd);
    QElapsedTimer clock;
    clock.start();
    bool eof = false;
    while (!eof && clock.elapsed() < timeoutMs) {
        struct pollfd p = { child.eventFd, POLLIN, 0 };
        const int left = timeoutMs - static_cast<int>(clock.elapsed());
        if (poll(&p, 1, left > 0 ? left : 0) <= 0) {
            continue;
        }
        char buffer[4096];
        const ssize_t n = read(child.eventFd, buffer, sizeof(buffer));
        if (n > 0 && out->size() < 65536) {
            out->append(buffer, static_cast<int>(n));
        } else if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) {
            eof = true;
        }
    }
    closeFd(child.eventFd);
    if (!eof) {
        kill(child.pid, SIGKILL);
    }
    int status = 0;
    while (waitpid(child.pid, &status, 0) < 0 && errno == EINTR) {
    }
    return eof && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

bool reap(pid_t pid)
{
    int status = 0;
    pid_t r;
    while ((r = waitpid(pid, &status, WNOHANG)) < 0 && errno == EINTR) {
    }
    return r == pid || (r < 0 && errno == ECHILD);
}

}

LineLink::LineLink(int readFd, int writeFd, QObject *parent)
    : QObject(parent)
    , m_readFd(readFd)
    , m_writeFd(writeFd)
    , m_readNotifier(nullptr)
    , m_writeNotifier(nullptr)
    , m_lines(ChildLink::LINE_MAX_BYTES)
{
    if (m_readFd >= 0) {
        fcntl(m_readFd, F_SETFL, fcntl(m_readFd, F_GETFL) | O_NONBLOCK);
        m_readNotifier = new QSocketNotifier(m_readFd, QSocketNotifier::Read, this);
        connect(m_readNotifier, &QSocketNotifier::activated, this, &LineLink::onReadable);
    }
    if (m_writeFd >= 0) {
        fcntl(m_writeFd, F_SETFL, fcntl(m_writeFd, F_GETFL) | O_NONBLOCK);
        m_writeNotifier = new QSocketNotifier(m_writeFd, QSocketNotifier::Write, this);
        m_writeNotifier->setEnabled(false);
        connect(m_writeNotifier, &QSocketNotifier::activated, this, &LineLink::onWritable);
    }
}

LineLink::~LineLink()
{
    closeRead();
    delete m_writeNotifier;
    m_writeNotifier = nullptr;
    if (m_writeFd >= 0) {
        close(m_writeFd);
    }
}

void LineLink::send(const QJsonObject &line)
{
    if (m_writeFd < 0) {
        return;
    }
    m_out += QJsonDocument(line).toJson(QJsonDocument::Compact);
    m_out += '\n';
    writeOut();
}

void LineLink::flush(int timeoutMs)
{
    QElapsedTimer clock;
    clock.start();
    while (!m_out.isEmpty() && m_writeFd >= 0 && clock.elapsed() < timeoutMs) {
        struct pollfd p = { m_writeFd, POLLOUT, 0 };
        if (poll(&p, 1, timeoutMs - static_cast<int>(clock.elapsed())) > 0) {
            writeOut();
        }
    }
}

void LineLink::writeOut()
{
    while (!m_out.isEmpty()) {
        const ssize_t n = write(m_writeFd, m_out.constData(), static_cast<size_t>(m_out.size()));
        if (n > 0) {
            m_out.remove(0, static_cast<int>(n));
        } else if (n < 0 && errno == EINTR) {
            continue;
        } else if (n < 0 && errno == EAGAIN) {
            break;
        } else {
            m_out.clear(); // the reader is gone: closed() comes from the read side
            break;
        }
    }
    if (m_writeNotifier) {
        m_writeNotifier->setEnabled(!m_out.isEmpty());
    }
}

void LineLink::onWritable()
{
    writeOut();
}

void LineLink::onReadable()
{
    char buffer[4096];
    std::vector<std::string> lines;
    bool gone = false;
    for (;;) {
        const ssize_t n = read(m_readFd, buffer, sizeof(buffer));
        if (n > 0) {
            m_lines.feed(buffer, static_cast<size_t>(n), lines);
            continue;
        }
        if (n < 0 && errno == EINTR) {
            continue;
        }
        gone = n == 0 || errno != EAGAIN;
        break;
    }
    QPointer<LineLink> self(this);
    for (const std::string &text : lines) {
        const QJsonDocument doc = QJsonDocument::fromJson(QByteArray(text.data(), static_cast<int>(text.size())));
        if (doc.isObject()) {
            emit received(doc.object());
            if (!self) {
                return; // a receiver deleted the link
            }
        }
    }
    if (gone) {
        closeRead();
        emit closed();
    }
}

void LineLink::closeRead()
{
    delete m_readNotifier;
    m_readNotifier = nullptr;
    if (m_readFd >= 0) {
        close(m_readFd);
        m_readFd = -1;
    }
}
