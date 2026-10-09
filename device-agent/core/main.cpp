#include "agent.h"
#include "client.h"

#include <QCoreApplication>
#include <QSocketNotifier>
#include <QStringList>
#include <csignal>
#include <cstdio>
#include <unistd.h>

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

// Self-pipe: SIGTERM/SIGINT become a Qt event so the daemon can remove its socket and directory.
int signalPipe[2] = { -1, -1 };

void onSignal(int)
{
    const char byte = 1;
    const ssize_t ignored = write(signalPipe[1], &byte, 1);
    (void)ignored;
}

int runDaemon(QCoreApplication &app)
{
    if (pipe(signalPipe) != 0) {
        perror("pipe");
        return 1;
    }
    Agent agent;
    QSocketNotifier notifier(signalPipe[0], QSocketNotifier::Read);
    QObject::connect(&notifier, &QSocketNotifier::activated, &app, [&](int) {
        char byte;
        const ssize_t ignored = read(signalPipe[0], &byte, 1);
        (void)ignored;
        agent.stop();
        app.quit();
    });
    signal(SIGTERM, onSignal);
    signal(SIGINT, onSignal);
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
