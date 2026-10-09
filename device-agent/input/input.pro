TEMPLATE = app
TARGET = sailfish-devagent-input
include(../common/module.pri)
# QtGui is for the touch overlay's QPainter.
QT = core network gui

SOURCES += \
    main.cpp \
    mirrorinput.cpp \
    touchoverlay.cpp \
    ../common/waylandutil.cpp

HEADERS += \
    mirrorinput.h \
    touchoverlay.h \
    ../common/keypadkeys.h \
    ../common/waylandutil.h

WAYLAND_CLIENT_PROTOCOLS = protocol/alien-manager.xml
include(../common/wayland.pri)
