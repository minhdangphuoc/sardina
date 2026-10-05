#include "agent.h"
#include "paths.h"
#include "screenshot.h"
#include "logs.h"
#include "mirror.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QLocalSocket>
#include <QDBusConnection>
#include <QDBusInterface>
#include <QDBusMessage>
#include <QVariantList>
#include <QVariantMap>
#include <QStringList>
#include <cstdio>

namespace {

const int RETRY_MS = 2000;
const int REQUEST_MAX_BYTES = 4096;
const int REQUEST_TIMEOUT_MS = 5000;
const int LOGS_DEFAULT_LINES = 100;
const int LOGS_MAX_LINES = 10000;
const int MIRROR_DEFAULT_FPS = 4;
const int MIRROR_DEFAULT_WIDTH = 360;
const int MIRROR_DEFAULT_QUALITY = 60;
const int MIRROR_MAX_WIDTH = 2160;
const int MIRROR_MIN_WIDTH = 90;

QJsonObject errorReply(const QString &message)
{
    QJsonObject o;
    o.insert(QStringLiteral("ok"), false);
    o.insert(QStringLiteral("error"), message);
    return o;
}

}

Agent::Agent(QObject *parent)
    : QObject(parent)
    , m_notified(false)
{
    m_retry.setInterval(RETRY_MS);
    m_retry.setSingleShot(true);
    connect(&m_retry, &QTimer::timeout, this, &Agent::tryListen);
    connect(&m_server, &QLocalServer::newConnection, this, &Agent::onNewConnection);
    // chmod 0600 on the socket: only the owning user may connect.
    m_server.setSocketOptions(QLocalServer::UserAccessOption);
}

Agent::~Agent()
{
    stop();
}

void Agent::start()
{
    tryListen();
}

void Agent::tryListen()
{
    if (m_server.isListening()) {
        return;
    }
    const QString userDir = Paths::userRuntimeDir();
    if (!QDir(userDir).exists()) {
        // The user session (and its bus) is not up yet; the unit is ordered after it, but be safe.
        fprintf(stderr, "sailfish-devagent: %s does not exist yet, retrying\n", qPrintable(userDir));
        m_retry.start();
        return;
    }
    const QString dir = Paths::agentRuntimeDir();
    if (!QDir().mkpath(dir)) {
        fprintf(stderr, "sailfish-devagent: cannot create %s, retrying\n", qPrintable(dir));
        m_retry.start();
        return;
    }
    QFile::setPermissions(dir, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner);

    const QString path = Paths::socketPath();
    QLocalServer::removeServer(path); // a stale socket from an unclean stop
    if (!m_server.listen(path)) {
        fprintf(stderr, "sailfish-devagent: cannot listen on %s: %s, retrying\n", qPrintable(path),
                qPrintable(m_server.errorString()));
        m_retry.start();
        return;
    }
    fprintf(stderr, "sailfish-devagent %s: listening on %s\n", AGENT_VERSION, qPrintable(path));
    notifyStarted();
}

void Agent::stop()
{
    m_retry.stop();
    if (m_server.isListening()) {
        m_server.close();
    }
    QLocalServer::removeServer(Paths::socketPath());
    QDir dir(Paths::agentRuntimeDir());
    if (dir.exists()) {
        // Only our own files live here: the socket and screenshots not yet fetched.
        dir.removeRecursively();
    }
}

// Best effort: a visible notification on the phone, once per start ("Visible" in the security model).
void Agent::notifyStarted()
{
    if (m_notified) {
        return;
    }
    QDBusConnection bus = QDBusConnection::connectToBus(Paths::sessionBusAddress(), QStringLiteral("devagent-notify"));
    if (!bus.isConnected()) {
        QDBusConnection::disconnectFromBus(QStringLiteral("devagent-notify"));
        return;
    }
    QDBusInterface notifications(QStringLiteral("org.freedesktop.Notifications"),
                                 QStringLiteral("/org/freedesktop/Notifications"),
                                 QStringLiteral("org.freedesktop.Notifications"), bus);
    QVariantMap hints;
    hints.insert(QStringLiteral("x-nemo-preview-summary"), QStringLiteral("Developer agent is running"));
    hints.insert(QStringLiteral("x-nemo-preview-body"),
                 QStringLiteral("VS Code can take screenshots and read system logs while Developer Mode is on."));
    QDBusMessage result = notifications.call(QStringLiteral("Notify"), QStringLiteral("sailfish-devagent"), uint(0),
                                             QStringLiteral("icon-m-developer-mode"),
                                             QStringLiteral("Developer agent is running"),
                                             QStringLiteral("VS Code can take screenshots and read system logs while Developer Mode is on."),
                                             QStringList(), hints, int(-1));
    m_notified = result.type() != QDBusMessage::ErrorMessage;
    QDBusConnection::disconnectFromBus(QStringLiteral("devagent-notify"));
}

void Agent::onNewConnection()
{
    while (QLocalSocket *socket = m_server.nextPendingConnection()) {
        connect(socket, &QLocalSocket::disconnected, socket, &QObject::deleteLater);
        readRequest(socket);
    }
}

// One JSON object on one line, then the reply. Anything oversized, slow or malformed is refused.
void Agent::readRequest(QLocalSocket *socket)
{
    QTimer *timeout = new QTimer(socket);
    timeout->setSingleShot(true);
    timeout->setInterval(REQUEST_TIMEOUT_MS);
    connect(timeout, &QTimer::timeout, socket, [this, socket]() {
        reply(socket, errorReply(QStringLiteral("request timeout")));
    });
    timeout->start();

    connect(socket, &QLocalSocket::readyRead, socket, [this, socket, timeout]() {
        if (!socket->canReadLine()) {
            if (socket->bytesAvailable() > REQUEST_MAX_BYTES) {
                reply(socket, errorReply(QStringLiteral("request too large")));
            }
            return;
        }
        timeout->stop();
        disconnect(socket, &QLocalSocket::readyRead, nullptr, nullptr);
        const QByteArray line = socket->readLine(REQUEST_MAX_BYTES);
        QJsonParseError parseError;
        const QJsonDocument doc = QJsonDocument::fromJson(line, &parseError);
        if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
            reply(socket, errorReply(QStringLiteral("malformed request")));
            return;
        }
        dispatch(socket, doc.object());
    });
    if (socket->canReadLine()) {
        emit socket->readyRead();
    }
}

void Agent::dispatch(QLocalSocket *socket, const QJsonObject &request)
{
    const QString cmd = request.value(QStringLiteral("cmd")).toString();

    if (cmd == QLatin1String("ping")) {
        // Answers even with Developer Mode off, so VS Code can say why the rest is refused.
        QJsonObject o;
        o.insert(QStringLiteral("ok"), true);
        o.insert(QStringLiteral("version"), QStringLiteral(AGENT_VERSION));
        o.insert(QStringLiteral("developerMode"), Paths::developerModeOn());
        reply(socket, o);
        return;
    }

    static const QStringList gated = { QStringLiteral("screenshot"), QStringLiteral("logs"), QStringLiteral("mirror") };
    if (!gated.contains(cmd)) {
        reply(socket, errorReply(QStringLiteral("unknown command")));
        return;
    }

    // Developer Mode gate: turning it off disables the agent without uninstalling it.
    if (!Paths::developerModeOn()) {
        reply(socket, errorReply(QStringLiteral("developer mode is off")));
        return;
    }

    if (cmd == QLatin1String("screenshot")) {
        Screenshot *shot = new Screenshot(socket);
        connect(shot, &Screenshot::finished, socket, [this, socket](const QJsonObject &result) {
            reply(socket, result);
        });
        shot->take();
        return;
    }

    if (cmd == QLatin1String("mirror")) {
        int fps = request.value(QStringLiteral("fps")).toInt(MIRROR_DEFAULT_FPS);
        fps = qBound(1, fps, 10);
        int width = request.value(QStringLiteral("width")).toInt(MIRROR_DEFAULT_WIDTH);
        if (width <= 0) {
            width = 0; // native size
        } else {
            width = qBound(MIRROR_MIN_WIDTH, width, MIRROR_MAX_WIDTH);
        }
        const int quality = qBound(1, request.value(QStringLiteral("quality")).toInt(MIRROR_DEFAULT_QUALITY), 100);
        // One mirror per daemon: the older connection is told and closed before the new one starts.
        if (m_mirror) {
            QLocalSocket *old = qobject_cast<QLocalSocket *>(m_mirror->parent());
            delete m_mirror.data();
            if (old) {
                reply(old, errorReply(QStringLiteral("replaced")));
            }
        }
        m_mirror = new MirrorStream(socket, fps, width, quality);
        return;
    }

    int lines = request.value(QStringLiteral("lines")).toInt(LOGS_DEFAULT_LINES);
    if (lines < 1) {
        lines = 1;
    }
    if (lines > LOGS_MAX_LINES) {
        lines = LOGS_MAX_LINES;
    }
    // Streams raw journal lines until the client goes away; owned by the socket.
    new LogStream(socket, lines);
}

void Agent::reply(QLocalSocket *socket, const QJsonObject &object)
{
    if (socket->state() != QLocalSocket::ConnectedState) {
        return;
    }
    socket->write(QJsonDocument(object).toJson(QJsonDocument::Compact));
    socket->write("\n");
    socket->flush();
    socket->disconnectFromServer();
}
