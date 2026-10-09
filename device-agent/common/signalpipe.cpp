#include "signalpipe.h"

#include <QSocketNotifier>
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <fcntl.h>
#include <unistd.h>

namespace {

int pipeFds[2] = { -1, -1 };

void onSignal(int signalNumber)
{
    const int saved = errno;
    const unsigned char byte = static_cast<unsigned char>(signalNumber);
    const ssize_t ignored = write(pipeFds[1], &byte, 1);
    (void)ignored;
    errno = saved;
}

}

SignalPipe::SignalPipe(const QList<int> &signalNumbers, QObject *parent)
    : QObject(parent)
    , m_notifier(nullptr)
{
    if (pipe2(pipeFds, O_CLOEXEC | O_NONBLOCK) != 0) {
        perror("pipe2");
        return;
    }
    m_notifier = new QSocketNotifier(pipeFds[0], QSocketNotifier::Read, this);
    connect(m_notifier, &QSocketNotifier::activated, this, &SignalPipe::onReadable);
    for (const int number : signalNumbers) {
        struct sigaction action = {};
        action.sa_handler = onSignal;
        sigemptyset(&action.sa_mask);
        action.sa_flags = SA_RESTART | (number == SIGCHLD ? SA_NOCLDSTOP : 0);
        sigaction(number, &action, nullptr);
    }
}

void SignalPipe::onReadable()
{
    unsigned char bytes[64];
    ssize_t n;
    while ((n = read(pipeFds[0], bytes, sizeof(bytes))) > 0) {
        for (ssize_t i = 0; i < n; ++i) {
            emit received(bytes[i]);
        }
    }
}
