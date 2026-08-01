// Pure A→B object matcher for the morph transition.
// Priority: manual pairing (morphLink) > shared item id > array index when types agree.
// Greedy and strictly 1:1 — each A/B item is consumed at most once.

export interface MorphPair {
    aIndex: number
    bIndex: number
}

export interface MorphMatch {
    pairs: MorphPair[]
    entering: number[] // B-only indexes (appear)
    exiting: number[] // A-only indexes (disappear)
}

interface MatchItem {
    id?: string
    type?: string
    morphLink?: string
}

/**
 * Reserved `morphLink` value meaning "never pair this item" — it fades in instead of morphing.
 * Needed because the index fallback pairs same-type items whether or not that is wanted, and this is
 * the only way to opt out. Checked before the id lookup, so an item whose own id is literally "none"
 * simply cannot be targeted (uid() never generates it; only hand-edited/imported shows could).
 */
export const MORPH_LINK_NONE = "none"

const typeOf = (it: MatchItem | undefined) => it?.type || "text"

interface LabelItem {
    type?: string
    src?: string
    lines?: { text?: { value?: string }[] }[]
}

/**
 * Human label for an item used as a morph source, e.g. `1. "Amazing grace"`. Shared by the picker
 * popup and the collapsed item-panel button so both read identically. `index` is 0-based.
 */
export function morphSourceLabel(item: LabelItem | undefined, index: number): string {
    const n = `${index + 1}. `
    const type = item?.type || "text"

    if (type === "text") {
        const text = (item?.lines || [])
            .flatMap((line) => (line?.text || []).map((t) => t?.value || ""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
        if (text) return `${n}"${text.length > 34 ? text.slice(0, 34) + "…" : text}"`
    }

    if (type === "media" && item?.src) return n + (item.src.split(/[/\\]/).pop() || item.src)

    return n + type
}

export function matchItems(a: MatchItem[], b: MatchItem[]): MorphMatch {
    const aUsed = new Array(a.length).fill(false)
    const bMatched = new Array(b.length).fill(false)
    const pairs: MorphPair[] = []

    const claimA = (pred: (item: MatchItem) => boolean): number => {
        for (let i = 0; i < a.length; i++) {
            if (!aUsed[i] && pred(a[i])) return i
        }
        return -1
    }

    // 0. explicit opt-out: skipped by every tier below, so it is never paired and never claims an A
    //    item (its would-be counterpart stays free, and both sides end up in entering/exiting).
    //    NOT flagged in bMatched — that array drives `entering`, which is exactly where these belong.
    const bOptOut = b.map((bi) => bi?.morphLink === MORPH_LINK_NONE)

    // 1. manual pairing (morphLink → A id)
    b.forEach((bi, bIndex) => {
        if (bMatched[bIndex] || bOptOut[bIndex] || !bi?.morphLink) return
        const aIndex = claimA((x) => x?.id === bi.morphLink)
        if (aIndex >= 0) {
            aUsed[aIndex] = true
            bMatched[bIndex] = true
            pairs.push({ aIndex, bIndex })
        }
    })

    // 2. shared id
    b.forEach((bi, bIndex) => {
        if (bMatched[bIndex] || bOptOut[bIndex] || !bi?.id) return
        const aIndex = claimA((x) => x?.id === bi.id)
        if (aIndex >= 0) {
            aUsed[aIndex] = true
            bMatched[bIndex] = true
            pairs.push({ aIndex, bIndex })
        }
    })

    // 3. index fallback (only when types agree)
    b.forEach((bi, bIndex) => {
        if (bMatched[bIndex] || bOptOut[bIndex]) return
        const i = bIndex
        if (i < a.length && !aUsed[i] && typeOf(a[i]) === typeOf(bi)) {
            aUsed[i] = true
            bMatched[bIndex] = true
            pairs.push({ aIndex: i, bIndex })
        }
    })

    const entering: number[] = []
    b.forEach((_, i) => {
        if (!bMatched[i]) entering.push(i)
    })
    const exiting: number[] = []
    a.forEach((_, i) => {
        if (!aUsed[i]) exiting.push(i)
    })

    return { pairs, entering, exiting }
}
