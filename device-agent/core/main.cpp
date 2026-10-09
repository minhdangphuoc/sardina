#include "agent.h"
#include "client.h"
#include "signalpipe.h"

#include <QCoreApplication>
#include <QStringList>
#include <csignal>
#include <cstdio>

namespace {

int usage()
{
    fprintf(stderr,
            "usage: sailfish-devagent --daemon\n"
            "       sailfish-devagent --request ping|screenshot\n"
            "       sailfish-devagent --request logs [--lines N] [--format json|text] [--after CURSOR]\n"
            "                         [--client TEXT]\n"
            "       sailfish-devagent --request stats --exe PATH [--interval MS] [--client TEXT]\n"
            "       sailfish-devagent --request mirror [--fps N] [--width N] [--quality N] [--lease N] [--input]\n"
            "                         [--phone-state] [--client TEXT]\n"
            "       sailfish-devagent --remove-notifications\n"
            "       sailfish-devagent --version\n");
    return 2;
}

int runDaemon(QCoreApplication &app)
{
    Agent agent;
    // SIGTERM/SIGINT become a Qt event so the daemon can remove its socket and directory.
    SignalPipe signalPipe(QList<int>() << SIGTERM << SIGINT << SIGCHLD);
    QObject::connect(&signalPipe, &SignalPipe::received, &app, [&](int number) {
        if (number == SIGCHLD) {
            agent.reapChildren();
            return;
        }
        agent.stop();
        app.quit();
    });
    signal(SIGPIPE, SIG_IGN); // a client vanishing mid-reply must not kill the daemon
    agent.start();
    return app.exec();
}

}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    app.setApplicationName(QStringLiteral("sailfish-devagent"));
    const QStringList args = app.arguments();
    if (args.size() < 2) {
        return usage();
    }
    const QString mode = args.at(1);
    if (mode == QLatin1String("--daemon")) {
        return runDaemon(app);
    }
    if (mode == QLatin1String("--request")) {
        if (args.size() < 3) {
            return usage();
        }
        return Client::run(args.mid(2));
    }
    if (mode == QLatin1String("--remove-notifications")) {
        return Agent::removeNotifications();
    }
    if (mode == QLatin1String("--version")) {
        printf("%s\n", AGENT_VERSION);
        return 0;
    }
    return usage();
}
