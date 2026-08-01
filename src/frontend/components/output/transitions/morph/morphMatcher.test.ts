import { describe, expect, it } from "vitest"
import { MORPH_LINK_NONE, matchItems, morphSourceLabel } from "./morphMatcher"

const item = (over: any = {}) => ({ type: "text", style: "", ...over })

describe("matchItems", () => {
    it("pairs by shared id", () => {
        const a = [item({ id: "x" }), item({ id: "y" })]
        const b = [item({ id: "y" }), item({ id: "x" })]
        const r = matchItems(a, b)
        expect(r.pairs).toEqual(
            expect.arrayContaining([
                { aIndex: 0, bIndex: 1 }, // x
                { aIndex: 1, bIndex: 0 } // y
            ])
        )
        expect(r.entering).toEqual([])
        expect(r.exiting).toEqual([])
    })
    it("manual morphLink overrides id/index", () => {
        const a = [item({ id: "a1" }), item({ id: "a2" })]
        const b = [item({ id: "b1", morphLink: "a2" })]
        const r = matchItems(a, b)
        expect(r.pairs).toEqual([{ aIndex: 1, bIndex: 0 }])
        expect(r.exiting).toEqual([0]) // a1 unmatched
    })
    it("falls back to index when types agree and no ids", () => {
        const a = [item({ type: "text" }), item({ type: "media" })]
        const b = [item({ type: "text" }), item({ type: "media" })]
        const r = matchItems(a, b)
        expect(r.pairs).toEqual([
            { aIndex: 0, bIndex: 0 },
            { aIndex: 1, bIndex: 1 }
        ])
    })
    it("does NOT index-match across differing types", () => {
        const a = [item({ type: "text" })]
        const b = [item({ type: "media" })]
        const r = matchItems(a, b)
        expect(r.pairs).toEqual([])
        expect(r.exiting).toEqual([0])
        expect(r.entering).toEqual([0])
    })
    it("is 1:1 — each a/b used at most once", () => {
        const a = [item({ id: "x" })]
        const b = [item({ id: "x" }), item({ id: "x" })] // pathological dup
        const r = matchItems(a, b)
        expect(r.pairs.length).toBe(1)
        expect(r.entering.length).toBe(1)
    })

    describe(`morphLink: "${MORPH_LINK_NONE}"`, () => {
        it("opts out of a shared-id match (fades instead of morphing)", () => {
            const a = [item({ id: "x" })]
            const b = [item({ id: "x", morphLink: MORPH_LINK_NONE })]
            const r = matchItems(a, b)
            expect(r.pairs).toEqual([])
            expect(r.entering).toEqual([0])
            expect(r.exiting).toEqual([0])
        })
        it("opts out of an index match", () => {
            const a = [item()]
            const b = [item({ morphLink: MORPH_LINK_NONE })]
            const r = matchItems(a, b)
            expect(r.pairs).toEqual([])
            expect(r.entering).toEqual([0])
        })
        it("frees its A counterpart for a later item to claim", () => {
            const a = [item({ id: "x" })]
            const b = [item({ id: "x", morphLink: MORPH_LINK_NONE }), item({ morphLink: "x" })]
            const r = matchItems(a, b)
            expect(r.pairs).toEqual([{ aIndex: 0, bIndex: 1 }])
            expect(r.entering).toEqual([0])
        })
    })

    describe("two B items link the SAME A item (1:1 is preserved)", () => {
        it("lowest B index wins the claim; the loser falls through to the index fallback", () => {
            const a = [item({ id: "a1" }), item({ id: "a2" })]
            const b = [item({ morphLink: "a1" }), item({ morphLink: "a1" })]
            const r = matchItems(a, b)
            expect(r.pairs).toEqual([
                { aIndex: 0, bIndex: 0 }, // won the link
                { aIndex: 1, bIndex: 1 } // silently fell back to index matching — NOT a1
            ])
        })
        it("the loser falls through to its own shared id when it has one", () => {
            const a = [item({ id: "a1" }), item({ id: "shared" })]
            const b = [item({ id: "x", morphLink: "a1" }), item({ id: "shared", morphLink: "a1" })]
            const r = matchItems(a, b)
            expect(r.pairs).toEqual([
                { aIndex: 0, bIndex: 0 },
                { aIndex: 1, bIndex: 1 } // matched by shared id, not by its link
            ])
        })
        it("never reuses an A item, and unclaimed losers fade in", () => {
            const a = [item({ id: "a1" })]
            const b = [item({ morphLink: "a1" }), item({ morphLink: "a1" }), item({ morphLink: "a1" })]
            const r = matchItems(a, b)
            expect(r.pairs).toEqual([{ aIndex: 0, bIndex: 0 }])
            expect(r.entering).toEqual([1, 2])
            const used = r.pairs.map((p) => p.aIndex)
            expect(new Set(used).size).toBe(used.length)
        })
    })

    it("an unresolvable morphLink falls through to id/index", () => {
        const a = [item({ id: "x" })]
        const b = [item({ id: "x", morphLink: "deleted" })]
        const r = matchItems(a, b)
        expect(r.pairs).toEqual([{ aIndex: 0, bIndex: 0 }]) // matched by shared id
    })
})

describe("morphSourceLabel", () => {
    it("uses the text content for text items", () => {
        expect(morphSourceLabel({ type: "text", lines: [{ text: [{ value: "Amazing grace" }] }] }, 0)).toBe('1. "Amazing grace"')
    })
    it("truncates long text", () => {
        const long = "a".repeat(60)
        const label = morphSourceLabel({ type: "text", lines: [{ text: [{ value: long }] }] }, 1)
        expect(label.length).toBeLessThan(45)
        expect(label).toContain("…")
        expect(label.startsWith("2. ")).toBe(true)
    })
    it("uses the file name for media items", () => {
        expect(morphSourceLabel({ type: "media", src: "/path/to/logo.png" }, 2)).toBe("3. logo.png")
    })
    it("falls back to the type for other items, and for empty text", () => {
        expect(morphSourceLabel({ type: "timer" }, 0)).toBe("1. timer")
        expect(morphSourceLabel({ type: "text", lines: [{ text: [{ value: "   " }] }] }, 0)).toBe("1. text")
    })
    it("defaults a missing type to text", () => {
        expect(morphSourceLabel({}, 0)).toBe("1. text")
    })
})
