TEMPLATE = app
TARGET = sailfish-devagent-stats
include(../common/module.pri)
QT = core network

SOURCES += main.cpp stats.cpp
HEADERS += stats.h statsmath.h
