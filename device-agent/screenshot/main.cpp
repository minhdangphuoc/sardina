#include "modulehost.h"
#include "screenshot.h"

#include <QCoreApplication>

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    ModuleHost host("screenshot");
    const int code = host.init(app.arguments());
    if (code >= 0) {
        return code;
    }
    Screenshot shot;
    QObject::connect(&shot, &Screenshot::finished, &host, &ModuleHost::replyAndFinish);
    QObject::connect(&host, &ModuleHost::started, &shot, &Screenshot::take);
    QObject::connect(&host, &ModuleHost::endRequested, &host, &ModuleHost::finish);
    return app.exec();
}
