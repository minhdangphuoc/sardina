cmake_minimum_required(VERSION 3.10)
project(harbour-cmake-demo)

find_package(Qt5 COMPONENTS Core Gui Qml Quick REQUIRED)

add_executable(harbour-cmake-demo src/main.cpp)
target_link_libraries(harbour-cmake-demo Qt5::Core Qt5::Gui Qt5::Qml Qt5::Quick)

install(TARGETS harbour-cmake-demo RUNTIME DESTINATION bin)
