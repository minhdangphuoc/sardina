#include "inputlink.h"
#include "childlink.h"
#include "keypadkeys.h"

#include <QElapsedTimer>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <cerrno>
#include <csignal>
#include <poll.h>
#include <unistd.h>

namespace {

const int READY_TIMEOUT_MS = 2000;
const int STOP_WAIT_MS = 500;

QJsonArray xy(const QPoint &p)
{
    return QJsonArray{ p.x(), p.y() };
}

// Reads the first line (the "ready" event) byte by byte, so nothing after it is taken from the
// pipe before the line link owns it.
bool readLine(int fd, int timeoutMs, QByteArray *line)
{
    QElapsedTimer clock;
    clock.start();
    while (clock.elapsed() < timeoutMs && line->size() < 4096) {
        struct pollfd p = { fd, POLLIN, 0 };
        if (poll(&p, 1, timeoutMs - static_cast<int>(clock.elapsed())) <= 0) {
            continue;
        }
        char c;
        const ssize_t n = read(fd, &c, 1);
        if (n == 1 && c == '\n') {
            return true;
        }
        if (n == 1) {
            line->append(c);
        } else if (n == 0 || (errno != EAGAIN && errno != EINTR)) {
            return false;
        }
    }
    return false;
}

}

InputLink::InputLink(const QString &executable, QObject *parent)
    : QObject(parent)
    , m_pid(-1)
    , m_link(nullptr)
    , m_touch(false)
    , m_keypad(false)
    , m_busy(false)
    , m_live(false)
    , m_overlayEnabled(false)
    , m_overlayWorks(true)
{
    if (executable.isEmpty()) {
        m_error = QStringLiteral("input module not installed");
    } else if (!start(executable)) {
        stop();
    }
}

InputLink::~InputLink()
{
    stop();
}

bool InputLink::start(const QString &executable)
{
    ChildLink::Child child;
    QString error;
    if (!ChildLink::spawn(executable.toLocal8Bit(), QList<QByteArray>() << QByteArrayLiteral("--serve"), -1, &child,
                          &error)) {
        m_error = QStringLiteral("input module failed to start: ") + error;
        return false;
    }
    m_pid = child.pid;
    m_link = new LineLink(-1, child.controlFd, this);
    send(QJsonObject{ { QStringLiteral("start"), true } });
    QByteArray line;
    const bool ready = readLine(child.eventFd, READY_TIMEOUT_MS, &line);
    const QJsonObject info = QJsonDocument::fromJson(line).object().value(QStringLiteral("ready")).toObject();
    if (!ready || info.isEmpty()) {
        close(child.eventFd);
        m_error = QStringLiteral("input module did not answer");
        return false;
    }
    m_touch = info.value(QStringLiteral("touch")).toBool(false);
    m_keypad = info.value(QStringLiteral("keypad")).toBool(false);
    m_error = info.value(QStringLiteral("error")).toString();
    // The events of a running stream: a second link reads them; this one keeps writing commands.
    LineLink *events = new LineLink(child.eventFd, -1, this);
    connect(events, &LineLink::received, this, &InputLink::onEvent);
    return true;
}

void InputLink::stop()
{
    m_touch = false;
    m_keypad = false;
    delete m_link; // EOF on its fd 0: the module releases any contact and exits
    m_link = nullptr;
    if (m_pid <= 0) {
        return;
    }
    QElapsedTimer clock;
    clock.start();
    while (!ChildLink::reap(m_pid) && clock.elapsed() < STOP_WAIT_MS) {
        usleep(10000);
    }
    if (clock.elapsed() >= STOP_WAIT_MS) {
        ::kill(m_pid, SIGKILL);
        while (!ChildLink::reap(m_pid)) {
            usleep(1000);
        }
    }
    m_pid = -1;
}

bool InputLink::validKeyName(const QString &key)
{
    return keypadKeyIndex(key) >= 0;
}

void InputLink::send(const QJsonObject &line)
{
    if (m_link) {
        m_link->send(line);
    }
}

void InputLink::setScreen(const QSize &size, bool nativeCoordinates)
{
    Q_UNUSED(nativeCoordinates); // the native recorder's coordinates are the only ones accepted
    send(QJsonObject{ { QStringLiteral("screen"), QJsonArray{ size.width(), size.height() } } });
}

void InputLink::tap(const QPoint &point)
{
    m_busy = true;
    m_live = false;
    send(QJsonObject{ { QStringLiteral("tap"), xy(point) } });
}

void InputLink::swipe(const QPoint &from, const QPoint &to, int durationMs)
{
    m_busy = true;
    m_live = false;
    send(QJsonObject{ { QStringLiteral("swipe"), QJsonArray{ from.x(), from.y(), to.x(), to.y(), durationMs } } });
}

void InputLink::contactDown(const QPoint &point)
{
    m_busy = true;
    m_live = true;
    send(QJsonObject{ { QStringLiteral("down"), xy(point) } });
}

void InputLink::contactMove(const QPoint &point)
{
    send(QJsonObject{ { QStringLiteral("move"), xy(point) } });
}

void InputLink::contactUp()
{
    m_busy = false;
    m_live = false;
    send(QJsonObject{ { QStringLiteral("up"), true } });
}

void InputLink::keyDown(const QString &key)
{
    send(QJsonObject{ { QStringLiteral("keyDown"), key } });
}

void InputLink::keyUp(const QString &key)
{
    send(QJsonObject{ { QStringLiteral("keyUp"), key } });
}

void InputLink::cancel()
{
    m_busy = false;
    m_live = false;
    send(QJsonObject{ { QStringLiteral("cancel"), true } });
}

void InputLink::setOverlayEnabled(bool enabled)
{
    if (enabled == m_overlayEnabled) {
        return;
    }
    m_overlayEnabled = enabled;
    send(QJsonObject{ { QStringLiteral("overlay"), enabled } });
}

void InputLink::onEvent(const QJsonObject &line)
{
    const QJsonValue state = line.value(QStringLiteral("state"));
    if (state.isObject()) {
        m_busy = state.toObject().value(QStringLiteral("busy")).toBool(false);
        m_live = state.toObject().value(QStringLiteral("live")).toBool(false);
        return;
    }
    const QJsonValue contact = line.value(QStringLiteral("contact"));
    if (contact.isObject()) {
        const QJsonObject c = contact.toObject();
        emit contactChanged(QPoint(c.value(QStringLiteral("x")).toInt(), c.value(QStringLiteral("y")).toInt()),
                            c.value(QStringLiteral("down")).toBool(false));
        return;
    }
    const QJsonValue overlay = line.value(QStringLiteral("overlay"));
    if (overlay.isBool() && overlay.toBool() != m_overlayWorks) {
        m_overlayWorks = overlay.toBool();
        emit overlayChanged();
    }
}
