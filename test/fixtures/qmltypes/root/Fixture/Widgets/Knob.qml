import QtQuick 2.0

Rectangle {
    id: knob
    property alias angle: pivot.rotation
    property real value: 0
    signal turned(real by)

    Item { id: pivot }
    MouseArea {
        anchors.fill: parent
        onClicked: knob.turned(1)
    }
}
