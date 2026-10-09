import QtQuick 2.0

StandinWindow {
    id: window
    property Item initialPage
    property alias pageCount: counter.count
    Item { id: counter; property int count: 0 }
}
