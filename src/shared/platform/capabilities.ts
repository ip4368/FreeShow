export interface CapabilitySet {
    outputWindows: boolean
    ndi: boolean
    blackmagic: boolean
    screenCapture: boolean
    midi: boolean
    nativeDialogs: boolean
    localFiles: boolean
    presentationControl: boolean
    spotify: boolean
    windowControls: boolean
    servers: boolean
}

export const ELECTRON_CAPABILITIES: CapabilitySet = {
    outputWindows: true,
    ndi: true,
    blackmagic: true,
    screenCapture: true,
    midi: true,
    nativeDialogs: true,
    localFiles: true,
    presentationControl: true,
    spotify: true,
    windowControls: true,
    servers: true
}
