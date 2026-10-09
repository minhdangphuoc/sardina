.pragma library

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}
