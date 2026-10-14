TEMPLATE = app
TARGET = sailfish-devagent-packages
include(../common/module.pri)
QT = core dbus network

SOURCES += main.cpp packagemonitor.cpp
HEADERS += packagemonitor.h
