#include "displaystate.h"

#include <QDBusConnection>
#include <QDBusMessage>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>

namespace {

const QString MCE_SERVICE = QStringLiteral("com.nokia.mce");

}

DisplayState::DisplayState(QObject *parent)
    : QObject(parent)
    , m_off(false)
{
    QDBusConnection bus = QDBusConnection::systemBus();
    bus.connect(MCE_SERVICE, QStringLiteral("/com/nokia/mce/signal"), QStringLiteral("com.nokia.mce.signal"),
                QStringLiteral("display_status_ind"), this, SLOT(onStatus(QString)));
    QDBusMessage call = QDBusMessage::createMethodCall(MCE_SERVICE, QStringLiteral("/com/nokia/mce/request"),
                                                       QStringLiteral("com.nokia.mce.request"),
                                                       QStringLiteral("get_display_status"));
    auto *watcher = new QDBusPendingCallWatcher(bus.asyncCall(call, 2000), this);
    connect(watcher, &QDBusPendingCallWatcher::finished, this, [this](QDBusPendingCallWatcher *w) {
        w->deleteLater();
        QDBusPendingReply<QString> reply = *w;
        if (reply.isValid()) {
            onStatus(reply.value());
        }
    });
}

void DisplayState::onStatus(const QString &status)
{
    const bool off = status == QLatin1String("off");
    if (off != m_off) {
        m_off = off;
        emit changed();
    }
}
