// ----- FreeShow -----
// Portable (no Electron) zip helpers, buffer-in/buffer-out. Mirrors the relevant
// parts of src/electron/data/zip.ts (yazl/yauzl), but that module can't be reused
// directly here: it imports Electron-only `sendToMain`/`utils/files`, and
// tsconfig.headless.json doesn't compile src/electron/**. Headless backups are
// JSON + .show files only (no media), so in-memory buffers are fine - no need for
// the disk-streaming path the Electron version uses for large media exports.

import yauzl from "yauzl"
import yazl from "yazl"

export interface ZipEntry {
    name: string
    content: string | Buffer
}

export function zipEntries(entries: ZipEntry[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const zipfile = new yazl.ZipFile()

        entries.forEach((entry) => {
            try {
                const buffer = typeof entry.content === "string" ? Buffer.from(entry.content, "utf-8") : entry.content
                zipfile.addBuffer(buffer, entry.name)
            } catch (err) {
                console.error(`Error adding to zip: ${entry.name}`, err)
            }
        })

        zipfile.end()

        const chunks: Buffer[] = []
        zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk))
        zipfile.outputStream.on("end", () => resolve(Buffer.concat(chunks)))
        zipfile.outputStream.on("error", (err) => reject(err))
    })
}

// neutralise path-traversal/absolute segments so a crafted archive can't write outside
// the extraction directory (zip-slip); copied from src/electron/data/zip.ts
function sanitizeZipPath(name: string): string {
    return name
        .replace(/\\/g, "/")
        .replace(/^([a-zA-Z]:|\/)/, "") // strip leading C: or /
        .split("/")
        .filter((segment) => segment && segment !== "." && segment !== "..")
        .join("/")
}

const STRING_CONVERT_LIMIT = 50 * 1024 * 1024 // 50 MB

export function unzipBuffer(buffer: Buffer): Promise<{ name: string; content: string }[]> {
    return new Promise((resolve, reject) => {
        const data: { name: string; content: string }[] = []

        yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: false } as any, (err, zipfile) => {
            if (err || !zipfile) {
                reject(err || new Error("Failed to open zip buffer"))
                return
            }

            zipfile.on("entry", (entry: yauzl.Entry) => {
                const fileName = (entry.fileName as any as Buffer).toString("utf8")

                // skip directories
                if (/\/$/.test(fileName)) {
                    zipfile.readEntry()
                    return
                }

                const name = sanitizeZipPath(fileName)

                zipfile.openReadStream(entry, (streamErr, readStream) => {
                    if (streamErr || !readStream) {
                        console.error("Failed to open zip entry stream:", name, streamErr)
                        zipfile.readEntry()
                        return
                    }

                    const chunks: Buffer[] = []
                    readStream.on("data", (chunk: Buffer) => chunks.push(chunk))
                    readStream.on("end", () => {
                        const contentBuffer = Buffer.concat(chunks)
                        if (contentBuffer.length > STRING_CONVERT_LIMIT) {
                            console.warn(`Skipped restoring oversized entry: ${name} (${contentBuffer.length} bytes)`)
                        } else {
                            data.push({ name, content: contentBuffer.toString("utf8") })
                        }
                        zipfile.readEntry()
                    })
                    readStream.on("error", (readErr) => {
                        console.error("Failed to read zip entry stream:", name, readErr)
                        zipfile.readEntry()
                    })
                })
            })

            zipfile.on("end", () => resolve(data))
            zipfile.on("error", (zipErr) => reject(zipErr))

            zipfile.readEntry()
        })
    })
}
