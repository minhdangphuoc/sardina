TEMPLATE = app
TARGET = sailfish-devagent-mirror
include(../common/module.pri)
# QtGui is for QImage (frame scaling, JPEG); VP8 through libvpx.
QT = core dbus network gui
PKGCONFIG += vpx

SOURCES += \
    main.cpp \
    mirror.cpp \
    indicatorlink.cpp \
    inputlink.cpp \
    recorder.cpp \
    videoencoder.cpp \
    displaystate.cpp \
    ../common/waylandutil.cpp

HEADERS += \
    mirror.h \
    indicatorlink.h \
    inputlink.h \
    pacer.h \
    yuvrows.h \
    retrybudget.h \
    recorder.h \
    videoencoder.h \
    displaystate.h \
    ../common/idleplan.h \
    ../common/phonesettings.h \
    ../common/waylandutil.h \
    ../common/keypadkeys.h

WAYLAND_CLIENT_PROTOCOLS = protocol/lipstick-recorder.xml
include(../common/wayland.pri)
