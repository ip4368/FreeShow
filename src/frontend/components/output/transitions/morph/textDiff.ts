// Pure word tokenization + word-level LCS diff for the word-level text morph.
// No Svelte/DOM deps → fast to unit test. See docs/plans/2026-07-29-word-text-morph-design.md.

interface LineLike {
    text?: { value?: string }[]
}

/** Flatten an item's lines into an ordered list of words (whitespace-separated), in reading order. */
export function extractWords(lines: LineLike[] | undefined): string[] {
    const words: string[] = []
    for (const line of lines || []) {
        for (const chunk of line?.text || []) {
            for (const w of (chunk?.value || "").split(/\s+/)) {
                if (w) words.push(w)
            }
        }
    }
    return words
}

export interface WordDiff {
    matched: { a: number; b: number }[] // indices into A and B of words that stay (move)
    removed: number[] // indices into A of words only on the previous slide (fade out)
    added: number[] // indices into B of words only on the new slide (fade in)
}

/**
 * Longest-common-subsequence diff of two word arrays (by exact word text, order-preserving).
 * Shared words → matched pairs; A-only → removed; B-only → added.
 */
export function diffWords(a: string[], b: string[]): WordDiff {
    const m = a.length
    const n = b.length
    // dp[i][j] = LCS length of a[i:] and b[j:]
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
        }
    }

    const matched: { a: number; b: number }[] = []
    const removed: number[] = []
    const added: number[] = []
    let i = 0
    let j = 0
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            matched.push({ a: i, b: j })
            i++
            j++
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            removed.push(i++)
        } else {
            added.push(j++)
        }
    }
    while (i < m) removed.push(i++)
    while (j < n) added.push(j++)

    return { matched, removed, added }
}
