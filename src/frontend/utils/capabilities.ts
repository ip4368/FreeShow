import { get } from "svelte/store"
import type { CapabilitySet } from "../../shared/platform/capabilities"
import { capabilities } from "../stores"

export function can(key: keyof CapabilitySet): boolean {
    return get(capabilities)[key]
}
