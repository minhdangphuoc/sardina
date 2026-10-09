# A module executable: started by the daemon in /usr/libexec/sailfish-devagent for one stream.
include(common.pri)
QT += network
HEADERS += $$PWD/modulehost.h
SOURCES += $$PWD/modulehost.cpp
target.path = /usr/libexec/sailfish-devagent
INSTALLS += target
