#ifndef POINTERTRACK_H
#define POINTERTRACK_H

#include <algorithm>

// Where a relative pointer is, as far as we know. A relative device cannot say "go to x,y", so the
// first move after forget() first pushes into the top-left corner (the compositor clamps there),
// which makes the position known again; later moves are plain deltas.
struct PointerMove {
    bool home; // send homeX/homeY first
    int homeX;
    int homeY;
    int dx;
    int dy;
};

class PointerTrack
{
public:
    void forget() { m_known = false; }

    PointerMove moveTo(int x, int y, int screenW, int screenH)
    {
        x = std::max(0, std::min(x, screenW - 1));
        y = std::max(0, std::min(y, screenH - 1));
        PointerMove m = { !m_known, 0, 0, 0, 0 };
        if (m.home) {
            m.homeX = m.homeY = -2 * std::max(screenW, screenH); // beyond any start position
            m_x = m_y = 0;
            m_known = true;
        }
        m.dx = x - m_x;
        m.dy = y - m_y;
        m_x = x;
        m_y = y;
        return m;
    }

private:
    bool m_known = false;
    int m_x = 0;
    int m_y = 0;
};

#endif
