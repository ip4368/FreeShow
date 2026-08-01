// Word position measurement for the word-level text morph.
// Pure helper (box-local coordinate conversion) is unit-tested; the DOM measurement (TreeWalker +
// Range) is verified in-app. Measurement copies must be rendered UNROTATED (rotation is applied by
// the animation container), so no inverse-rotation is needed here.

export interface WordBox {
    text: string
    x: number // box-local px (output-resolution space), from the box top-left
    y: number
    fontSize: number // rendered px (output-resolution space)
    lineHeight: number // ACTUAL line box height (from the measured rect) in output-res px — overlay matches this so glyphs align vertically
    color: string
    fontFamily: string
    fontWeight: string
    fontStyle: string
}

interface Rect {
    left: number
    top: number
    width?: number
    height?: number
}

/**
 * Convert a measured screen rect into box-local, output-resolution px.
 * Both `rect` and `boxRect` are getBoundingClientRect values measured inside the same `.zoom`
 * container (so CSS `zoom` cancels); `ratio` = slide zoom factor. Result is relative to the box
 * top-left, in the unscaled output-resolution space that item.style / interpolateStyle use.
 */
export function rectToBoxLocal(rect: Rect, boxRect: Rect, ratio: number): { x: number; y: number } {
    const r = ratio || 1
    return { x: (rect.left - boxRect.left) / r, y: (rect.top - boxRect.top) / r }
}

/**
 * Measure every word rendered inside `root` (a text item's rendered element), returning each word's
 * box-local position, font size and color. `boxRect`/`ratio` map screen px → box-local output-res px.
 * Uses a TreeWalker over text nodes (crossing nested {@html} spans) and inserts breaks at <br>, then
 * Range-measures each whitespace-delimited word. Words with no rendered rect (empty/hidden) are skipped.
 */
export function measureWords(root: HTMLElement, boxRect: Rect, ratio: number): WordBox[] {
    // Build a flat string of the rendered text plus an offset→(node, offset) map; BR becomes "\n".
    const nodes: { node: Text; start: number }[] = []
    let flat = ""
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    let cur: Node | null = walker.currentNode
    while ((cur = walker.nextNode())) {
        if (cur.nodeType === Node.TEXT_NODE) {
            const t = cur as Text
            nodes.push({ node: t, start: flat.length })
            flat += t.data
        } else if ((cur as HTMLElement).tagName === "BR") {
            flat += "\n"
        }
    }

    // locate the (text node, offset) for a global flat offset
    const locate = (offset: number): { node: Text; offset: number } | null => {
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i]
            if (offset >= n.start) return { node: n.node, offset: offset - n.start }
        }
        return null
    }

    const words: WordBox[] = []
    const wordRe = /\S+/g
    let m: RegExpExecArray | null
    while ((m = wordRe.exec(flat))) {
        const startPos = locate(m.index)
        const endPos = locate(m.index + m[0].length - 1)
        if (!startPos || !endPos) continue
        const range = document.createRange()
        try {
            range.setStart(startPos.node, startPos.offset)
            range.setEnd(endPos.node, endPos.offset + 1)
        } catch {
            continue
        }
        const rects = range.getClientRects()
        const rect = rects[0] || range.getBoundingClientRect()
        if (!rect || (rect.width === 0 && rect.height === 0)) continue
        const local = rectToBoxLocal(rect, boxRect, ratio)
        const style = window.getComputedStyle(startPos.node.parentElement as Element)
        // NOTE: getBoundingClientRect is zoomed (positions/line-height divide by ratio), but
        // getComputedStyle.fontSize returns the UNZOOMED (output-resolution) px here, so it is used directly.
        // Line-height = the ACTUAL measured line box height (rect.height) so the overlay matches real layout.
        const lineHeight = (rect.height || parseFloat(style.fontSize) * (ratio || 1)) / (ratio || 1)
        words.push({ text: m[0], x: local.x, y: local.y, fontSize: parseFloat(style.fontSize), lineHeight, color: style.color, fontFamily: style.fontFamily, fontWeight: style.fontWeight, fontStyle: style.fontStyle })
    }
    return words
}
