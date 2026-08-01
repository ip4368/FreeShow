import { describe, expect, it } from "vitest"
import { rectToBoxLocal } from "./wordMeasure"

describe("rectToBoxLocal", () => {
    it("converts a screen rect to box-local output-resolution px", () => {
        // box top-left at screen (100,50); word at (150,80); zoom ratio 0.5
        // local = (150-100)/0.5, (80-50)/0.5 = (100, 60)
        expect(rectToBoxLocal({ left: 150, top: 80 }, { left: 100, top: 50 }, 0.5)).toEqual({ x: 100, y: 60 })
    })
    it("ratio 1 is a plain offset from the box", () => {
        expect(rectToBoxLocal({ left: 300, top: 220 }, { left: 200, top: 200 }, 1)).toEqual({ x: 100, y: 20 })
    })
    it("guards ratio 0", () => {
        expect(rectToBoxLocal({ left: 10, top: 10 }, { left: 0, top: 0 }, 0)).toEqual({ x: 10, y: 10 })
    })
})
