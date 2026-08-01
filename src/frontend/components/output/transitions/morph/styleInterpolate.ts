// Pure style-interpolation helpers for the morph transition.
// No Svelte/store dependencies so this stays fast to unit test.
//
// NOTE: we intentionally do NOT reuse helpers/style.ts `getStyles`, because it spreads
// synthetic pseudo-keys out of `transform` (e.g. `transform: rotate(10deg)` also yields
// `rotate: "10"`). Parsing the raw string here keeps `transform` a single explicit key.

export type StyleMap = Record<string, string>

/** Parse a `;`-delimited inline CSS string into a key→value map (no transform pseudo-keys). */
export function parseMorphStyle(style: string): StyleMap {
    const map: StyleMap = {}
    if (!style) return map
    for (const part of style.split(";")) {
        const idx = part.indexOf(":")
        if (idx < 0) continue
        const key = part.slice(0, idx).trim()
        const value = part.slice(idx + 1).trim()
        if (!key || !value) continue
        map[key] = value
    }
    return map
}

/**
 * True if the style declares a non-empty `transform` (any function: rotate, rotateX tilt, scaleX flip,
 * perspective, ...). Deliberately broader than a `rotate(` test — the editor writes all four
 * (see edit/values/item.ts) and the word morph can represent none of them: it measures UNROTATED probes
 * and lays the overlay out in flat slide space. Matches only a real `transform:` declaration, never the
 * unrelated `text-transform:`.
 */
export function hasTransform(style: string | undefined): boolean {
    return /(^|;)\s*transform\s*:\s*[^;]*\([^)]*\)/.test(style || "")
}

/** Extract the rotation (deg) from a transform string; 0 if none. Mirrors Movebox.svelte. */
export function getRotationDeg(transform: string): number {
    const m = /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec(transform || "")
    return m ? +m[1] : 0
}

function fmtNum(n: number): string {
    return String(+n.toFixed(3))
}

const NUM_UNIT = /^(-?\d*\.?\d+)([a-z%]*)$/i

/** Lerp a numeric-with-unit value (keeps the unit). Non-numeric values switch at t>=0.5. */
export function lerpNumberUnit(a: string, b: string, t: number): string {
    const ma = NUM_UNIT.exec(a.trim())
    const mb = NUM_UNIT.exec(b.trim())
    if (ma && mb) {
        const n = +ma[1] + (+mb[1] - +ma[1]) * t
        const unit = mb[2] || ma[2] || ""
        return fmtNum(n) + unit
    }
    return t < 0.5 ? a : b
}

interface RGBA {
    r: number
    g: number
    b: number
    a: number
}

function parseColor(c: string): RGBA | null {
    const s = c.trim()
    if (s[0] === "#") {
        let hex = s.slice(1)
        if (hex.length === 3)
            hex = hex
                .split("")
                .map((x) => x + x)
                .join("")
        if (hex.length !== 6) return null
        const r = parseInt(hex.slice(0, 2), 16)
        const g = parseInt(hex.slice(2, 4), 16)
        const b = parseInt(hex.slice(4, 6), 16)
        if ([r, g, b].some(isNaN)) return null
        return { r, g, b, a: 1 }
    }
    const m = /^rgba?\(([^)]+)\)$/i.exec(s)
    if (m) {
        const p = m[1].split(",").map((x) => +x.trim())
        if (p.length < 3 || p.slice(0, 3).some(isNaN)) return null
        return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }
    }
    return null
}

/** Lerp two colors via rgba channels. Unparseable inputs (gradients, var(), named) switch at t>=0.5. */
export function lerpColor(a: string, b: string, t: number): string {
    const ca = parseColor(a)
    const cb = parseColor(b)
    if (!ca || !cb) return t < 0.5 ? a : b
    const r = Math.round(ca.r + (cb.r - ca.r) * t)
    const g = Math.round(ca.g + (cb.g - ca.g) * t)
    const bl = Math.round(ca.b + (cb.b - ca.b) * t)
    const al = +(ca.a + (cb.a - ca.a) * t).toFixed(3)
    return `rgba(${r}, ${g}, ${bl}, ${al})`
}

function isColorKey(key: string): boolean {
    return key === "color" || key.endsWith("color")
}

function transformTokens(transform: string): string[] {
    return transform.match(/[a-zA-Z-]+\([^)]*\)/g) || []
}

function nonRotateTokens(transform: string): string[] {
    return transformTokens(transform).filter((tok) => !/^rotate\(/i.test(tok))
}

/**
 * FLIP transform: the CSS transform to apply to an element positioned at B's geometry so it
 * visually appears at A's geometry (position/size/rotation). Animating this transform to "none"
 * morphs the element from A to B. transform-origin must be top-left (0 0) to match left/top.
 */
export function computeFlipTransform(aStyle: string, bStyle: string): string {
    const a = parseMorphStyle(aStyle)
    const b = parseMorphStyle(bStyle)
    const num = (v: string | undefined) => (v ? parseFloat(v) || 0 : 0)
    const bw = num(b.width)
    const bh = num(b.height)
    const sx = bw ? num(a.width) / bw : 1
    const sy = bh ? num(a.height) / bh : 1
    // pivot on each box's CENTER (matches computeFlipOrigin) so rotation is natural and scale stays centered
    const dx = num(a.left) + num(a.width) / 2 - (num(b.left) + bw / 2)
    const dy = num(a.top) + num(a.height) / 2 - (num(b.top) + bh / 2)
    // shortest-path rotation delta (never > 180deg)
    const dr = ((((getRotationDeg(a.transform || "") - getRotationDeg(b.transform || "")) % 360) + 540) % 360) - 180
    return `translate(${fmtNum(dx)}px, ${fmtNum(dy)}px) rotate(${fmtNum(dr)}deg) scale(${fmtNum(sx)}, ${fmtNum(sy)})`
}

/**
 * transform-origin for a FLIP wrapper: the item's own CENTER (its B box center). The wrapper sits at
 * the slide origin, so scale/rotate must pivot around the item's center — not the slide corner — and
 * center rotation matches the item's own rotate() and Keynote/PowerPoint behavior.
 */
export function computeFlipOrigin(bStyle: string): string {
    const b = parseMorphStyle(bStyle)
    const num = (v: string | undefined) => (v ? parseFloat(v) || 0 : 0)
    return `${fmtNum(num(b.left) + num(b.width) / 2)}px ${fmtNum(num(b.top) + num(b.height) / 2)}px`
}

/**
 * Interpolate the full inline style from A to B at time t (0..1).
 * - position/size/numeric props: lerp with unit
 * - colors: rgba channel lerp
 * - transform: interpolate rotation only; non-rotate tokens snap to the B (target) value
 * - anything unparseable / one-sided: switch at t>=0.5
 */
export function interpolateStyle(styleA: string, styleB: string, t: number): string {
    const a = parseMorphStyle(styleA)
    const b = parseMorphStyle(styleB)
    const out: StyleMap = {}

    const keys: string[] = []
    for (const k of Object.keys(a)) keys.push(k)
    for (const k of Object.keys(b)) if (!keys.includes(k)) keys.push(k)

    for (const key of keys) {
        if (key === "transform") continue // handled below
        const valA = a[key]
        const valB = b[key]
        if (valA !== undefined && valB !== undefined) {
            out[key] = isColorKey(key) ? lerpColor(valA, valB, t) : lerpNumberUnit(valA, valB, t)
        } else if (valB !== undefined) {
            // present only on target: snap in at the midpoint
            if (t >= 0.5) out[key] = valB
        } else if (valA !== undefined) {
            // present only on source: snap out at the midpoint
            if (t < 0.5) out[key] = valA
        }
    }

    if (a.transform !== undefined || b.transform !== undefined) {
        const rotA = getRotationDeg(a.transform || "")
        const rotB = getRotationDeg(b.transform || "")
        // shortest-path rotation: normalize the delta to (-180, 180] so we never spin > 180deg
        const delta = ((((rotB - rotA) % 360) + 540) % 360) - 180
        const rot = rotA + delta * t
        // non-rotate tokens follow the target (B) when it defines a transform, else keep source's
        const keep = b.transform !== undefined ? nonRotateTokens(b.transform) : nonRotateTokens(a.transform || "")
        out.transform = [`rotate(${fmtNum(rot)}deg)`, ...keep].join(" ")
    }

    return (
        Object.entries(out)
            .map(([k, v]) => `${k}:${v}`)
            .join(";") + ";"
    )
}
