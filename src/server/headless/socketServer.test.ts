import fs from "fs"
import http from "http"
import os from "os"
import path from "path"
import type { AddressInfo } from "net"
import { io as ioClient, Socket as ClientSocket } from "socket.io-client"
import { Server } from "socket.io"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setDataRoot } from "./data/dataPaths"
import { registerClient } from "./socketServer"
import { zipEntries } from "../../shared/data/zip"

let tmp = ""
let server: http.Server
let io: Server
let url = ""

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-socketserver-"))
    setDataRoot(tmp)

    server = http.createServer()
    io = new Server(server)
    io.on("connection", (socket) => registerClient(io, socket))

    await new Promise<void>((resolve) => server.listen(0, resolve))
    url = `http://localhost:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    io.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmp, { recursive: true, force: true })
})

const openSockets: ClientSocket[] = []
function connect(): Promise<ClientSocket> {
    const socket = ioClient(url, { transports: ["websocket"], reconnection: false })
    openSockets.push(socket)
    return new Promise((resolve) => socket.on("connect", () => resolve(socket)))
}

afterEach(() => {
    while (openSockets.length) openSockets.pop()?.close()
})

function sendMain(socket: ClientSocket, channel: string, data?: any, listenerId?: string) {
    socket.emit("MAIN", { data: { channel, data }, listenerId })
}

function onceMain(socket: ClientSocket, channel: string): Promise<any> {
    return new Promise((resolve) => {
        const handler = (payload: any) => {
            if (payload?.data?.channel !== channel) return
            socket.off("MAIN", handler)
            resolve(payload.data.data)
        }
        socket.on("MAIN", handler)
    })
}

describe("headless socketServer RESTORE_UPLOAD", () => {
    it("replies to the uploader and broadcasts the new SHOWS index to every connected client", async () => {
        const a = await connect()
        const b = await connect()

        const zip = await zipEntries([{ name: "SHOWS/Broadcast Song.show", content: JSON.stringify(["bcast1", { name: "Broadcast Song", slides: {} }]) }])

        const aReply = onceMain(a, "RESTORE_UPLOAD")
        const aShows = onceMain(a, "SHOWS")
        const bShows = onceMain(b, "SHOWS")

        sendMain(a, "RESTORE_UPLOAD", zip, "listener1")

        const [reply, aIndex, bIndex] = await Promise.all([aReply, aShows, bShows])

        expect(reply).toEqual({ finished: true })
        expect(aIndex.bcast1).toMatchObject({ name: "Broadcast Song" })
        expect(bIndex.bcast1).toMatchObject({ name: "Broadcast Song" })
        expect(fs.existsSync(path.join(tmp, "Shows", "Broadcast Song.show"))).toBe(true)
    })

    it("reports a failure without broadcasting anything for a bad upload", async () => {
        const a = await connect()

        const aReply = onceMain(a, "RESTORE_UPLOAD")
        sendMain(a, "RESTORE_UPLOAD", Buffer.from("not a zip"), "listener2")

        const reply = await aReply
        expect(reply.finished).toBe(false)
        expect(reply.error).toBeTruthy()
    })
})
