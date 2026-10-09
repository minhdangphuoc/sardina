TEMPLATE = app
TARGET = sailfish-devagent-screenshot
include(../common/module.pri)
QT = core dbus network

SOURCES += main.cpp screenshot.cpp capture.cpp
HEADERS += screenshot.h capture.h
