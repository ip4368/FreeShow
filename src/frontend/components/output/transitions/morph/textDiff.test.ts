import { describe, expect, it } from "vitest"
import { alignSignature, diffWords, extractWords } from "./textDiff"

describe("alignSignature", () => {
    const centered = { align: "align-items:center;", lines: [{ align: "text-align:center;", text: [{ value: "Amazing grace" }] }] }

    it("is stable for identical alignment", () => {
        expect(alignSignature(centered)).toBe(alignSignature({ ...centered }))
    })
    it("changes when the vertical alignment (item.align) changes", () => {
        const top = { ...centered, align: "align-items:flex-start;" }
        expect(alignSignature(top)).not.toBe(alignSignature(centered))
    })
    it("changes when a line's horizontal alignment (line.align) changes", () => {
        const left = { ...centered, lines: [{ align: "text-align:left;", text: [{ value: "Amazing grace" }] }] }
        expect(alignSignature(left)).not.toBe(alignSignature(centered))
    })
    it("changes when only one of several lines is realigned", () => {
        const a = {
            lines: [
                { align: "text-align:center;", text: [] },
                { align: "text-align:center;", text: [] }
            ]
        }
        const b = {
            lines: [
                { align: "text-align:center;", text: [] },
                { align: "text-align:right;", text: [] }
            ]
        }
        expect(alignSignature(a)).not.toBe(alignSignature(b))
    })
    it("treats missing alignment as empty (no crash, stable)", () => {
        expect(alignSignature(undefined)).toBe(alignSignature({}))
        expect(alignSignature({ lines: [{ text: [] }] })).toBe(alignSignature({ lines: [{ align: "", text: [] }] }))
    })
    it("distinguishes a differing line count", () => {
        expect(alignSignature({ lines: [{ align: "text-align:left;", text: [] }] })).not.toBe(
            alignSignature({
                lines: [
                    { align: "text-align:left;", text: [] },
                    { align: "text-align:left;", text: [] }
                ]
            })
        )
    })
})

describe("extractWords", () => {
    it("flattens lines/chunks into ordered words", () => {
        const lines = [{ text: [{ value: "Amazing grace" }, { value: " how" }] }, { text: [{ value: "sweet" }] }]
        expect(extractWords(lines)).toEqual(["Amazing", "grace", "how", "sweet"])
    })
    it("handles empty/missing", () => {
        expect(extractWords(undefined)).toEqual([])
        expect(extractWords([{ text: [{ value: "   " }] }])).toEqual([])
    })
})

describe("diffWords", () => {
    it("keeps shared words, removes A-only, adds B-only", () => {
        const d = diffWords(["Amazing", "Grace"], ["Amazing", "Love"])
        expect(d.matched).toEqual([{ a: 0, b: 0 }]) // Amazing
        expect(d.removed).toEqual([1]) // Grace
        expect(d.added).toEqual([1]) // Love
    })
    it("identical text → all matched", () => {
        const d = diffWords(["a", "b", "c"], ["a", "b", "c"])
        expect(d.matched).toEqual([
            { a: 0, b: 0 },
            { a: 1, b: 1 },
            { a: 2, b: 2 }
        ])
        expect(d.removed).toEqual([])
        expect(d.added).toEqual([])
    })
    it("4 lines → last 2 lines: first-half words removed, rest matched (the 4→2 case)", () => {
        const a = ["l1", "l2", "l3", "l4"]
        const b = ["l3", "l4"]
        const d = diffWords(a, b)
        expect(d.matched).toEqual([
            { a: 2, b: 0 },
            { a: 3, b: 1 }
        ])
        expect(d.removed).toEqual([0, 1])
        expect(d.added).toEqual([])
    })
    it("2 lines → 4 lines: new words added, shared matched", () => {
        const d = diffWords(["l3", "l4"], ["l1", "l2", "l3", "l4"])
        expect(d.matched).toEqual([
            { a: 0, b: 2 },
            { a: 1, b: 3 }
        ])
        expect(d.added).toEqual([0, 1])
        expect(d.removed).toEqual([])
    })
    it("completely different → all removed + added", () => {
        const d = diffWords(["x", "y"], ["p", "q"])
        expect(d.matched).toEqual([])
        expect(d.removed).toEqual([0, 1])
        expect(d.added).toEqual([0, 1])
    })
    it("insertion in the middle keeps surrounding words matched", () => {
        const d = diffWords(["the", "cat"], ["the", "big", "cat"])
        expect(d.matched).toEqual([
            { a: 0, b: 0 }, // the
            { a: 1, b: 2 } // cat
        ])
        expect(d.added).toEqual([1]) // big
        expect(d.removed).toEqual([])
    })
})
