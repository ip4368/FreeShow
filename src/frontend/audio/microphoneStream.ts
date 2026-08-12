/**
 * Shared, reference counted capture of a physical audio input device.
 *
 * Chromium keeps one capture path per input device and shares it between every
 * getUserMedia track opened on that device. The audio processing options
 * (echo cancellation, noise suppression, automatic gain control) belong to that
 * shared path, not to the individual track, so a second stream asking for a
 * different set of options reconfigures the capture for everyone already on it:
 * the device is restarted (audio drops out for the length of the restart) and
 * the level changes as AGC engages or disengages.
 *
 * That is why every consumer goes through here. One open per device, one fixed
 * constraint set, closed only once the last consumer has released it. A meter
 * appearing or disappearing must never disturb a microphone that is live.
 */

// Live sound wants the raw signal. Processing belongs in the routing graph,
// where it is visible and can be switched off, not hidden in the capture.
const AUDIO_PROCESSING_OFF = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
}

interface DeviceCapture {
    consumers: Set<string>
    stream: MediaStream | null
    pending: Promise<MediaStream | null>
}

const captures = new Map<string, DeviceCapture>()

// the two things that can hold a device open
export const MIC_PLAYBACK_CONSUMER = "playback"
export const MIC_MONITOR_CONSUMER = "monitor"

export const MIC_ID_PREFIX = "mic_sub_"
/** "<deviceId>" | "mic_sub_<deviceId>" -> "mic_sub_<deviceId>" */
export const micPlaybackId = (id: string) => (id.startsWith(MIC_ID_PREFIX) ? id : MIC_ID_PREFIX + id)
/** "<deviceId>" | "mic_sub_<deviceId>" -> "<deviceId>" */
export const micDeviceId = (id: string) => (id.startsWith(MIC_ID_PREFIX) ? id.slice(MIC_ID_PREFIX.length) : id)

export function getMicrophoneConstraints(deviceId: string): MediaStreamConstraints {
    return { audio: { deviceId: { exact: deviceId }, ...AUDIO_PROCESSING_OFF } }
}

function stopStream(stream: MediaStream | null) {
    if (!stream) return
    stream.getTracks().forEach((track) => track.stop())
}

/**
 * Opens the device if it is not open already and registers `consumer` as
 * needing it. Resolves with null if every consumer released it again while the
 * open was still in flight. Rejects with the getUserMedia error.
 */
export function acquireMicrophoneStream(deviceId: string, consumer: string): Promise<MediaStream | null> {
    let capture = captures.get(deviceId)

    if (!capture) {
        const newCapture: DeviceCapture = {
            consumers: new Set(),
            stream: null,
            pending: navigator.mediaDevices.getUserMedia(getMicrophoneConstraints(deviceId)).then((stream) => {
                // released while waiting for permission or hardware
                if (!newCapture.consumers.size) {
                    stopStream(stream)
                    return null
                }

                newCapture.stream = stream
                return stream
            })
        }

        // let a failed open be retried, without turning the shared rejection
        // into an unhandled one for consumers that don't await it
        newCapture.pending.catch(() => {
            if (captures.get(deviceId) === newCapture) captures.delete(deviceId)
        })

        capture = newCapture
        captures.set(deviceId, capture)
    }

    capture.consumers.add(consumer)
    return capture.pending
}

/** Returns true when this was the last consumer and the device was closed. */
export function releaseMicrophoneStream(deviceId: string, consumer: string): boolean {
    const capture = captures.get(deviceId)
    if (!capture || !capture.consumers.delete(consumer)) return false
    if (capture.consumers.size) return false

    captures.delete(deviceId)
    stopStream(capture.stream)
    return true
}

export function isMicrophoneStreamOpen(deviceId: string): boolean {
    return captures.has(deviceId)
}

/** Test seam. */
export function resetMicrophoneStreams() {
    captures.forEach((capture) => stopStream(capture.stream))
    captures.clear()
}
