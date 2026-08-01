import { describe, expect, it } from "vitest"
import { computeFlipOrigin, computeFlipTransform, interpolateStyle, lerpColor, lerpNumberUnit, parseMorphStyle } from "./styleInterpolate"

describe("computeFlipOrigin", () => {
    it("returns the item's own center as the pivot", () => {
        // center = (120 + 50/2, 80 + 50/2) = (145, 105)
        expect(computeFlipOrigin("left:120px;top:80px;width:50px;height:50px;")).toBe("145px 105px")
    })
})

describe("computeFlipTransform", () => {
    it("maps B's box to A's box (center-delta translate + scale)", () => {
        // A center (50,50), B center (200,150) → translate (-150,-100); scale 100/200
        const t = computeFlipTransform("left:0px;top:0px;width:100px;height:100px;", "left:100px;top:50px;width:200px;height:200px;")
        expect(t).toContain("translate(-150px, -100px)")
        expect(t).toContain("scale(0.5, 0.5)")
    })
    it("includes shortest-path rotation delta", () => {
        const t = computeFlipTransform("left:0px;top:0px;width:10px;height:10px;transform:rotate(10deg);", "left:0px;top:0px;width:10px;height:10px;transform:rotate(350deg);")
        // A - B = 10 - 350 = -340 -> shortest is +20
        expect(t).toContain("rotate(20deg)")
    })
})

describe("parseMorphStyle", () => {
    it("drops transform pseudo-keys (rotate) and keeps real transform", () => {
        const parsed = parseMorphStyle("left:10px;transform:rotate(10deg);")
        expect(parsed.rotate).toBeUndefined()
        expect(parsed.transform).toBe("rotate(10deg)")
        expect(parsed.left).toBe("10px")
    })
})

describe("lerpNumberUnit", () => {
    it("lerps numeric values keeping the unit", () => {
        expect(lerpNumberUnit("0px", "100px", 0.5)).toBe("50px")
    })
    it("switches non-numeric values at t>=0.5", () => {
        expect(lerpNumberUnit("left", "right", 0.4)).toBe("left")
        expect(lerpNumberUnit("left", "right", 0.6)).toBe("right")
    })
})

describe("lerpColor", () => {
    it("lerps hex colors via rgba channels", () => {
        expect(lerpColor("#000000", "#ffffff", 0.5)).toBe("rgba(128, 128, 128, 1)")
    })
    it("lerps rgba alpha", () => {
        expect(lerpColor("rgba(0,0,0,0)", "rgba(0,0,0,1)", 0.5)).toBe("rgba(0, 0, 0, 0.5)")
    })
    it("falls back to switch for gradients", () => {
        const a = "linear-gradient(#000,#111)"
        const b = "linear-gradient(#fff,#eee)"
        expect(lerpColor(a, b, 0.6)).toBe(b)
    })
})

describe("interpolateStyle", () => {
    it("interpolates position/size and rebuilds rotation into transform", () => {
        const out = interpolateStyle("left:0px;top:0px;transform:rotate(0deg);", "left:100px;top:50px;transform:rotate(90deg);", 0.5)
        expect(out).toContain("left:50px")
        expect(out).toContain("top:25px")
        expect(out).toContain("rotate(45deg)")
    })
    it("snaps a differing non-rotate transform token to the B value", () => {
        const out = interpolateStyle("transform:rotate(0deg) scale(1);", "transform:rotate(0deg) scale(2);", 0.5)
        expect(out).toContain("scale(2)")
    })
    it("passes a shared non-rotate token through unchanged", () => {
        const out = interpolateStyle("transform:rotate(0deg) translate(10px, 20px);", "transform:rotate(90deg) translate(10px, 20px);", 0.5)
        expect(out).toContain("translate(10px, 20px)")
        expect(out).toContain("rotate(45deg)")
    })
    it("takes the shortest rotation path (never > 180deg)", () => {
        // 10deg -> 350deg is -20deg the short way (via 0/360), not +340
        const out = interpolateStyle("transform:rotate(10deg);", "transform:rotate(350deg);", 0.5)
        expect(out).toContain("rotate(0deg)")
    })
    it("interpolates a color property", () => {
        const out = interpolateStyle("color:#000000;", "color:#ffffff;", 0.5)
        expect(out).toContain("color:rgba(128, 128, 128, 1)")
    })
})
