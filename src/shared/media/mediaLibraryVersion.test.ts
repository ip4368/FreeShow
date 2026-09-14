import { describe, expect, it } from "vitest"
import { decideLibraryReconcile } from "./mediaLibraryVersion"

describe("decideLibraryReconcile", () => {
    it("adopts the baseline on first contact (no reconcile)", () => {
        expect(decideLibraryReconcile(null, 7)).toEqual({ reconcile: false, seen: 7 })
    })

    it("stays quiet when the epoch is unchanged", () => {
        expect(decideLibraryReconcile(7, 7)).toEqual({ reconcile: false, seen: 7 })
    })

    it("reconciles when the epoch moved while away", () => {
        expect(decideLibraryReconcile(7, 9)).toEqual({ reconcile: true, seen: 9 })
        // backwards too (server restored from backup): stale either way
        expect(decideLibraryReconcile(9, 7)).toEqual({ reconcile: true, seen: 7 })
    })

    it("never reconciles on an unknown current (old server), keeping the baseline", () => {
        expect(decideLibraryReconcile(7, undefined)).toEqual({ reconcile: false, seen: 7 })
        expect(decideLibraryReconcile(7, "9")).toEqual({ reconcile: false, seen: 7 })
        expect(decideLibraryReconcile(null, undefined)).toEqual({ reconcile: false, seen: null })
    })
})
