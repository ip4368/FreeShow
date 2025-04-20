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

io.on("connection", (socket) => {
    console.log("a user connected")

    let namespace: string

    socket.on("setNamespace", (namespace_local: string) => {
        namespace = namespace_local
        socket.emit("receive", { channel: "STARTUP", data: { channel: "TYPE", data: "main" } })
    })

    socket.on("send", (message) => {
        console.log("namespace", namespace, message)
    })

    socket.on("disconnect", () => {
        console.log("user disconnected")
    })
})

server.listen(3001, () => {
    console.log("server running at http://localhost:3001")
})
