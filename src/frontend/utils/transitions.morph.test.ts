import { describe, expect, it } from "vitest"
import { transitions, transitionTypes } from "./transitions"

describe("morph registration", () => {
    it("lists morph as a selectable transition type", () => {
        expect(transitionTypes.some((t) => t.id === "morph")).toBe(true)
    })
    it("has a morph entry in the transitions map (marker)", () => {
        expect(transitions).toHaveProperty("morph")
    })
})
