import { BrowserWindow, NativeImage, ResizeOptions, app, nativeImage } from "electron"
import fs from "fs"
import path from "path"
import { isProd, loadWindowContent } from ".."
import { OUTPUT } from "../../types/Channels"
import { ToMain } from "../../types/IPC/ToMain"
import type { Output } from "../../types/Output"
import type { Resolution } from "../../types/Settings"
import { sendToMain } from "../IPC/main"
import { OutputHelper } from "../output/OutputHelper"
import { createFolder, dataFolderNames, doesPathExist, doesPathExistAsync, makeDir } from "../utils/files"
import { waitUntilValueIsDefined } from "../utils/helpers"
import { captureOptions } from "../utils/windowOptions"
import { imageExtensions, videoExtensions } from "./media"

export function getThumbnail(data: { input: string; size: number }) {
    let output = createThumbnail(data.input, data.size || 500)

    return { ...data, output }
}

export function createThumbnail(filePath: string, size: number = 250) {
    if (!filePath) return ""

    let outputPath = getThumbnailPath(filePath, size)

    addToGenerateQueue({ input: filePath, output: outputPath, size })

    return outputPath
}

type Thumbnail = { input: string; output: string; size: number }
let thumbnailQueue: Thumbnail[] = []
function addToGenerateQueue(data: Thumbnail) {
    thumbnailQueue.push(data)
    nextInQueue()
}

let working = false
function nextInQueue() {
    if (working || !thumbnailQueue[0]) return
    // if (!thumbnailQueue[0]) return removeCaptureWindow()

    working = true
    generateThumbnail(thumbnailQueue.shift()!)
}

function generationFinished() {
    working = false
    nextInQueue()
}

let exists: string[] = []
async function generateThumbnail(data: Thumbnail) {
    if (![...imageExtensions, ...videoExtensions].includes(getExtension(data.input))) return generationFinished()
    if (isProd && exists.includes(data.output)) return generationFinished()
    if (await doesPathExistAsync(data.output)) {
        exists.push(data.output)
        generationFinished()
        return
    }

    try {
        await generate(data.input, data.output, data.size + "x?", { seek: 0.5 })
    } catch (err) {
        console.error(err)
        generationFinished()
    }
}

let thumbnailFolderPath: string = ""
export function getThumbnailFolderPath() {
    if (thumbnailFolderPath) return thumbnailFolderPath

    let p: string = path.join(app.getPath("temp"), "freeshow-cache")
    if (!doesPathExist(p)) makeDir(p)
    thumbnailFolderPath = p

    return p
}

function getThumbnailPath(filePath: string, size: number = 250) {
    let folderPath = thumbnailFolderPath || getThumbnailFolderPath()
    return path.join(folderPath, `${filePathHashCode(filePath)}-${size}.png`)
}

export function filePathHashCode(str: string) {
    let hash = 0

    for (let i = 0; i < str.length; i++) {
        let chr = str.charCodeAt(i)
        hash = (hash << 5) - hash + chr // bit shift
        hash |= 0 // convert to 32bit integer
    }

    if (hash < 0) return "i" + hash.toString().slice(1)
    return "a" + hash.toString()
}

///// GENERATE /////

interface Config {
    seek?: number // 0-1
    // format?: "jpg" | "jpeg" | "png"
    // quality?: number // 0-100
}
// const customImageCapture = ["gif", "webp"]
async function generate(input: string, output: string, size: string, config: Config = {}) {
    if (!input || !output) {
        generationFinished()
        return
    }

    const parsedSize = parseSize(size)
    // let extension = getExtension(input)

    // capture images directly from electron nativeImage (fastest)
    // WIP this was unreliable
    // if (!customImageCapture.includes(extension) && defaultSettings.imageExtensions.includes(extension)) return captureImage(input, output, parsedSize)

    // capture other media with canvas in main window
    await captureWithCanvas({ input, output, size: parsedSize, extension: getExtension(input), config })
}

let mediaBeingCaptured: number = 0
const maxAmount = 20
const refillMargin = maxAmount * 0.6
async function captureWithCanvas(data: { input: string; output: string; size: ResizeOptions; extension: string; config: Config }) {
    if (!(await doesPathExistAsync(data.input))) {
        generationFinished()
        return
    }

    mediaBeingCaptured++
    sendToMain(ToMain.CAPTURE_CANVAS, data)

    // let captureIndex = mediaBeingCaptured
    // console.time("CAPTURING: " + captureIndex + " - " + data.input)

    // generate a max amount at the same time
    if (mediaBeingCaptured > maxAmount) await waitUntilValueIsDefined(() => mediaBeingCaptured < refillMargin)

    // console.timeEnd("CAPTURING: " + captureIndex + " - " + data.input)
    generationFinished()
}

export function saveImage(data: { path: string; base64?: string; filePath?: string[]; format?: "png" | "jpg" }) {
    const dataURL = data.base64
    let savePath = data.path

    if (data.filePath?.length) {
        const fileName = data.filePath.pop()!
        const folderPath = path.join(savePath, dataFolderNames.exports, ...data.filePath)
        createFolder(folderPath)
        savePath = path.join(folderPath, fileName)
    } else {
        mediaBeingCaptured = Math.max(0, mediaBeingCaptured - 1)
    }

    if (!dataURL || !savePath) return

    let image = nativeImage.createFromDataURL(dataURL)
    saveToDisk(savePath, image, false, data.format || "png")
}

// https://www.electronjs.org/docs/latest/api/native-image
// function captureImage(input: string, output: string, size: ResizeOptions) {
//     let outputImage = nativeImage.createFromPath(input)
//     outputImage = outputImage.resize(size)

//     saveToDisk(output, outputImage)
// }

function getExtension(filePath: string) {
    return path.extname(filePath).slice(1).toLowerCase()
}

function parseSize(sizeStr: string): ResizeOptions {
    const size: ResizeOptions = {}

    const sizeRegex = /(\d+|\?)x(\d+|\?)/g
    const sizeResult = sizeRegex.exec(sizeStr)
    if (sizeResult) {
        const sizeValues = sizeResult.map((x) => (x === "?" ? null : Number.parseInt(x)))

        if (sizeValues[1]) size.width = sizeValues[1] || 0
        if (sizeValues[2]) size.height = sizeValues[2] || 0

        return size
    }

    throw new Error("Invalid size string")
}

///// SAVE /////

const jpegQuality = 90 // 0-100
function saveToDisk(savePath: string, image: NativeImage, nextOnFinished: boolean = true, format: "png" | "jpg") {
    let img
    if (format === "jpg") img = image.toJPEG(jpegQuality)
    else img = image.toPNG() // higher file size, but supports transparent images

    fs.writeFile(savePath, img, (err) => {
        if (!err) exists.push(savePath)
        if (nextOnFinished) generationFinished()
    })
}

///// CAPTURE SLIDE /////

export function captureSlide(data: { output: { [key: string]: Output }; resolution: Resolution }): Promise<{ base64: string } | undefined> {
    return new Promise((resolve) => {
        const outSlide = Object.values(data.output)[0].out?.slide
        const OUTPUT_ID = "capture" + outSlide?.id + outSlide?.layout + outSlide?.index
        if (OutputHelper.getOutput(OUTPUT_ID)) return

        let window = new BrowserWindow({ ...captureOptions, width: data.resolution?.width, height: data.resolution?.height })
        loadWindowContent(window, "output")

        OutputHelper.setOutput(OUTPUT_ID, { window })

        window.on("ready-to-show", () => {
            // send correct output data after load
            setTimeout(() => {
                window.webContents.send(OUTPUT, { channel: "OUTPUTS", data: data.output })
                // WIP mute videos

                // wait for content load
                setTimeout(async () => {
                    const page = await window.capturePage()
                    const base64 = page.toDataURL({ scaleFactor: 1 })
                    resolve({ base64 })

                    window.destroy()
                    OutputHelper.deleteOutput(OUTPUT_ID)
                }, 3000)
            }, 1000)
        })
    })
}
