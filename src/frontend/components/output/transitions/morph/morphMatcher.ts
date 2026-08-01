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

const typeOf = (it: MatchItem | undefined) => it?.type || "text"

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

    // 1. manual pairing (morphLink → A id)
    b.forEach((bi, bIndex) => {
        if (bMatched[bIndex] || !bi?.morphLink) return
        const aIndex = claimA((x) => x?.id === bi.morphLink)
        if (aIndex >= 0) {
            aUsed[aIndex] = true
            bMatched[bIndex] = true
            pairs.push({ aIndex, bIndex })
        }
    })

    // 2. shared id
    b.forEach((bi, bIndex) => {
        if (bMatched[bIndex] || !bi?.id) return
        const aIndex = claimA((x) => x?.id === bi.id)
        if (aIndex >= 0) {
            aUsed[aIndex] = true
            bMatched[bIndex] = true
            pairs.push({ aIndex, bIndex })
        }
    })

    // 3. index fallback (only when types agree)
    b.forEach((bi, bIndex) => {
        if (bMatched[bIndex]) return
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
