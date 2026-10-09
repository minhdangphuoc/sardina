#include "mirrorinput.h"
#include "modulehost.h"
#include "touchoverlay.h"

#include <QCoreApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QPoint>
#include <cstdio>

// The input module: started by the mirror process for one stream that asked for control. Commands
// arrive as lines on fd 0, state goes back on fd 1; it never sees the client's socket. Every
// gate (control allowed, input lease, the "controlled" indicator) is the mirror's.
namespace {

int printKeypad()
{
    const MirrorKeypadInfo keypad = MirrorInput::keypadInfo();
    QJsonObject o;
    if (!keypad.model.isEmpty() && !keypad.keys.isEmpty()) {
        o.insert(QStringLiteral("model"), keypad.model);
        o.insert(QStringLiteral("keys"), QJsonArray::fromStringList(keypad.keys));
    }
    printf("%s\n", QJsonDocument(o).toJson(QJsonDocument::Compact).constData());
    return 0;
}

QPoint point(const QJsonValue &value, int offset = 0)
{
    const QJsonArray a = value.toArray();
    return QPoint(a.at(offset).toInt(-1), a.at(offset + 1).toInt(-1));
}

class InputServer : public QObject
{
public:
    explicit InputServer(ModuleHost *host)
        : m_host(host)
    {
        connect(&m_input, &MirrorInput::contactChanged, this, [this](const QPoint &p, bool down) {
            m_overlay.setContact(p, down);
            m_host->sendEvent(QJsonObject{ { QStringLiteral("contact"),
                                             QJsonObject{ { QStringLiteral("x"), p.x() },
                                                          { QStringLiteral("y"), p.y() },
                                                          { QStringLiteral("down"), down } } } });
        });
        connect(&m_input, &MirrorInput::stateChanged, this, &InputServer::sendState);
        m_host->sendEvent(QJsonObject{ { QStringLiteral("ready"),
                                         QJsonObject{ { QStringLiteral("touch"), m_input.touchAvailable() },
                                                      { QStringLiteral("keypad"), m_input.keypadAvailable() },
                                                      { QStringLiteral("error"), m_input.error() } } } });
    }

    void handle(const QJsonObject &line)
    {
        if (line.contains(QStringLiteral("screen"))) {
            const QJsonArray size = line.value(QStringLiteral("screen")).toArray();
            const QSize screen(size.at(0).toInt(), size.at(1).toInt());
            m_input.setScreen(screen, true);
            m_overlay.setScreen(screen);
        } else if (line.contains(QStringLiteral("tap"))) {
            m_input.tap(point(line.value(QStringLiteral("tap"))));
        } else if (line.contains(QStringLiteral("swipe"))) {
            const QJsonArray a = line.value(QStringLiteral("swipe")).toArray();
            m_input.swipe(point(a), point(a, 2), a.at(4).toInt());
        } else if (line.contains(QStringLiteral("down"))) {
            m_input.contactDown(point(line.value(QStringLiteral("down"))));
        } else if (line.contains(QStringLiteral("move"))) {
            m_input.contactMove(point(line.value(QStringLiteral("move"))));
        } else if (line.contains(QStringLiteral("up"))) {
            m_input.contactUp();
        } else if (line.contains(QStringLiteral("keyDown"))) {
            m_input.keyDown(line.value(QStringLiteral("keyDown")).toString());
        } else if (line.contains(QStringLiteral("keyUp"))) {
            m_input.keyUp(line.value(QStringLiteral("keyUp")).toString());
        } else if (line.contains(QStringLiteral("cancel"))) {
            m_input.cancel();
        } else if (line.contains(QStringLiteral("overlay"))) {
            const bool enabled = line.value(QStringLiteral("overlay")).toBool(false);
            m_overlay.setEnabled(enabled);
            if (enabled) {
                m_host->sendEvent(QJsonObject{ { QStringLiteral("overlay"), m_overlay.showingOnPhone() } });
            }
            return;
        }
        sendState(); // also after a refused command, so the mirror's guess is corrected
    }

    void release() { m_input.cancel(); }

private:
    void sendState()
    {
        m_host->sendEvent(QJsonObject{ { QStringLiteral("state"),
                                         QJsonObject{ { QStringLiteral("busy"), m_input.busy() },
                                                      { QStringLiteral("live"), m_input.liveContact() } } } });
    }

    ModuleHost *m_host;
    MirrorInput m_input;
    TouchOverlay m_overlay;
};

}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    if (app.arguments().value(1) == QLatin1String("--keypad")) {
        return printKeypad();
    }
    ModuleHost host("input", false);
    const int code = host.init(app.arguments());
    if (code >= 0) {
        return code;
    }
    InputServer *server = nullptr;
    QObject::connect(&host, &ModuleHost::started, [&](const QJsonObject &) { server = new InputServer(&host); });
    QObject::connect(&host, &ModuleHost::control, [&](const QJsonObject &line) {
        if (server) {
            server->handle(line);
        }
    });
    QObject::connect(&host, &ModuleHost::endRequested, &host, &ModuleHost::finish);
    const int result = app.exec();
    if (server) {
        server->release(); // no contact or key stays down after the mirror is gone
        delete server;
    }
    return result;
}
