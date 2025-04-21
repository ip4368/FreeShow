import express from "express"
import { createServer } from "node:http"
import { Server } from "socket.io"
import path from "path"
import { fileURLToPath } from "url"
import { dirname } from "path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const server = createServer(app)
const io = new Server(server, {
    // transports: ["websocket"],
    // cors: {
    //     origin: "http://localhost:3001",
    // },
})

app.use("/", express.static(path.join(__dirname, "../../public")))

// io.engine.on("connection_error", (err) => {
//     console.log(err.req) // the request object
//     console.log(err.code) // the error code, for example 1
//     console.log(err.message) // the error message, for example "Session ID unknown"
//     console.log(err.context) // some additional error context
// })

type StoreMessage = {
    channel: "STORE"
    data: {
        path: string | null | undefined
        dataPath: string
        SETTINGS: {}
        SYNCED_SETTINGS: {}
        SHOWS: {}
        STAGE_SHOWS: {}
        PROJECTS: {}
        OVERLAYS: {}
        TEMPLATES: {}
        EVENTS: {}
        MEDIA: {}
        THEMES: {}
        DRIVE_API_KEY: {}
        showsCache: {}
        scripturesCache: {}
        deletedShows: any[]
        renamedShows: any[]
        CACHE: {}
        HISTORY: {}
        USAGE: {}
        closeWhenFinished: boolean
        customTriggers: {}
    }
}

type MainChannel = {
    channel: "MAIN"
    data: { channel: "VERSION" | "IS_DEV" | "GET_OS" | "GET_TEMP_PATHS" | "DEVICE_ID" | "MAXIMIZED" | "DISPLAY" | "PCO_STARTUP_LOAD"; data: any }
}

type OutputMessage = {
    channel: "OUTPUT"
    data: {}
}

type StageMessage = {
    channel: "STAGE"
    data: {}
}

type BaseMessage = StoreMessage | OutputMessage | StageMessage | MainChannel

io.on("connection", (socket) => {
    console.log("a user connected")

    let namespace: string

    socket.on("setNamespace", (namespace_local: string) => {
        namespace = namespace_local
        socket.emit("receive", { channel: "STARTUP", data: { channel: "TYPE", data: "main" } })
    })

    socket.on("send", (message: BaseMessage) => {
        switch (message.channel) {
            case "STORE":
                console.log("namespace", namespace, "parsed STORE message", message)
                break
            case "MAIN":
                console.log("namespace", namespace, "parsed MAIN message", message)
                break
            case "STAGE":
            case "OUTPUT":
                return
            default:
                console.log("namespace", namespace, message)
        }
    })

    socket.on("disconnect", () => {
        console.log("user disconnected")
    })
})

server.listen(3001, () => {
    console.log("server running at http://localhost:3001")
})
