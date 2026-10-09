TEMPLATE = app
TARGET = sailfish-devagent-mirror
include(../common/module.pri)
# QtGui is for QImage (frame scaling, JPEG); VP8 through libvpx.
QT = core dbus network gui
PKGCONFIG += vpx

INCLUDEPATH += ../input

SOURCES += \
    main.cpp \
    mirror.cpp \
    indicatorlink.cpp \
    recorder.cpp \
    videoencoder.cpp \
    displaystate.cpp \
    ../input/mirrorinput.cpp \
    ../input/touchoverlay.cpp \
    ../common/waylandutil.cpp

HEADERS += \
    mirror.h \
    indicatorlink.h \
    pacer.h \
    yuvrows.h \
    retrybudget.h \
    recorder.h \
    videoencoder.h \
    displaystate.h \
    ../common/idleplan.h \
    ../common/phonesettings.h \
    ../common/waylandutil.h \
    ../input/mirrorinput.h \
    ../input/touchoverlay.h

WAYLAND_CLIENT_PROTOCOLS = protocol/lipstick-recorder.xml ../input/protocol/alien-manager.xml
include(../common/wayland.pri)
