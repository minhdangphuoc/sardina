import QtQuick 2.0
import Sailfish.Silica.private 1.0 as Private

Private.StandinWindow {
    id: window
    property Item initialPage
    property alias pageCount: counter.count
    Item { id: counter; property int count: 0 }
}
