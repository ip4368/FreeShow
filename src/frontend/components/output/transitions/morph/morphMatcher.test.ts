import { describe, expect, it } from "vitest"
import { matchItems } from "./morphMatcher"

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
})
