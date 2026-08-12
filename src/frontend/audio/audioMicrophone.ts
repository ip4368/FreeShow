import { get } from "svelte/store"
import { Main } from "../../types/IPC/Main"
import { sendMain } from "../IPC/main"
import { outLocked } from "../stores"
import { AudioAnalyser } from "./audioAnalyser"
import { clearAudio } from "./audioFading"
import { acquireMicrophoneStream, MIC_MONITOR_CONSUMER, MIC_PLAYBACK_CONSUMER, micDeviceId, micPlaybackId, releaseMicrophoneStream } from "./microphoneStream"
import { AudioInputCapture } from "./routing/audioInputCapture"
import { AudioPlayer } from "./audioPlayer"
import { AudioRoutingManager } from "./routing/audioRoutingManager"

type AudioMetadata = {
    name: string
}
type AudioOptions = {
    pauseIfPlaying?: boolean
}

interface AudioMicrophoneMonitor {
    source: MediaStreamAudioSourceNode | null
    consumers: Set<string>
}

const micMonitorId = (deviceId: string) => "mic_monitor_" + micDeviceId(deviceId)

export class AudioMicrophone {
    static volumes: { [deviceId: string]: number } = {}
    private static monitors: { [deviceId: string]: AudioMicrophoneMonitor } = {}

    static start(deviceId: string, metadata: AudioMetadata, options: AudioOptions = {}) {
        if (get(outLocked)) return

        const id = micPlaybackId(deviceId)
        if (AudioPlayer.audioExists(id)) {
            if (options.pauseIfPlaying) AudioPlayer.stop(id)
            return
        }

        acquireMicrophoneStream(deviceId, MIC_PLAYBACK_CONSUMER)
            .then((stream) => {
                if (!stream) return
                AudioPlayer.playStream(id, stream, metadata)
            })
            .catch((err) => {
                console.error(err)
                if (err.name === "NotReadableError") {
                    sendMain(Main.ACCESS_MICROPHONE_PERMISSION)
                }
            })
    }

    static stop(id: string) {
        if (!id) return
        clearAudio(micPlaybackId(id), { clearPlaylist: false, clearMicrophones: true })
        // AudioPlayer.stop(micId)
    }

    /**
     * Taps the device for metering only, without routing it anywhere audible.
     * Shares the capture with playback, so a meter can come and go while the
     * microphone stays live. Resolves false if the device could not be opened.
     */
    static startListening(deviceId: string, consumer = MIC_MONITOR_CONSUMER): Promise<boolean> {
        let monitor = this.monitors[deviceId]
        if (!monitor) {
            monitor = { source: null, consumers: new Set() }
            this.monitors[deviceId] = monitor
        }
        monitor.consumers.add(consumer)
        // playback may already hold this device, in which case there is nothing to reopen
        if (monitor.source) return Promise.resolve(true)

        return acquireMicrophoneStream(deviceId, MIC_MONITOR_CONSUMER)
            .then((stream) => {
                // torn down, or restarted as a different monitor, while the device was opening
                if (!stream || this.monitors[deviceId] !== monitor) return false
                // a concurrent startListening for the same device got there first
                if (monitor.source) return true

                const source = AudioAnalyser.getAudioContext().createMediaStreamSource(stream)
                monitor.source = source

                // registering it means AudioInputCapture can re-create the
                // analysers itself after a routing update prunes them
                AudioRoutingManager.getInstance().registerInputNode(micMonitorId(deviceId), source)
                return true
            })
            .catch((err) => {
                console.error("Could not start microphone listener:", err)
                return false
            })
    }

    static stopListening(deviceId: string, consumer = MIC_MONITOR_CONSUMER) {
        const monitor = this.monitors[deviceId]
        if (!monitor) return

        monitor.consumers.delete(consumer)
        if (monitor.consumers.size) return

        // A device only stays open for as long as something asked for it. An armed
        // microphone holds its own playback reference, so this only ever closes a
        // capture that was open purely to draw a meter.
        delete this.monitors[deviceId]

        if (monitor.source) {
            AudioRoutingManager.getInstance().unregisterInputNode(micMonitorId(deviceId), monitor.source)
            AudioInputCapture.getInstance().removeInput(micMonitorId(deviceId))
        }

        releaseMicrophoneStream(deviceId, MIC_MONITOR_CONSUMER)
    }

    static getVolume(deviceId: string): number {
        const capture = AudioInputCapture.getInstance()
        // prefer the routed signal, and fall back to the metering tap when the microphone isn't live
        const data = capture.getVisualizerData(micPlaybackId(deviceId)) || capture.getVisualizerData(micMonitorId(deviceId))
        if (data && typeof data.db === "number") return data.db
        if (data && data.channels?.[0]) return data.channels[0].db
        return -60
    }

    static async getList() {
        return navigator.mediaDevices.enumerateDevices().then((devices) => {
            return devices?.filter((device) => device.kind === "audioinput" && device.deviceId !== "default")
        })
    }
}
