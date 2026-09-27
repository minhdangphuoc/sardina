#include <QGuiApplication>
#include <sailfishapp.h>

static bool debugFlag = false;

int main(int argc, char *argv[])
{
    QScopedPointer<QGuiApplication> app(SailfishApp::application(argc, argv));
    QScopedPointer<QQuickView> view(SailfishApp::createView());

if (debugFlag) {
    foo();
}

    view->setSource(SailfishApp::pathTo("qml/harbour-demo.qml"));
    view->show();
    return app->exec();
}

