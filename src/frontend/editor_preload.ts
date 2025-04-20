import { io, Socket } from "socket.io-client"

class APIHooks {
    handler: { [key: string]: any }
    send: (_channel: string, _data?: any) => void
    receive: (channel: string, func: any, _id?: string) => void
    removeListener: (_channel: string, _id: string) => void
    showFilePath: (_file: File) => string
    pendingReceive: { [key: string]: any[] }

    constructor(socket: Socket) {
        socket.on("connect_error", (err) => {
            console.log(`connect_error due to ${err.message}`)
        })
        console.log(socket.active, socket.connected, socket.connect())
        let url = new URL(document.URL)
        const params = new URLSearchParams(url.search)
        const namespace = params.get("namespace") ?? "default"
        socket.on("connect", () => {
            socket.emit("setNamespace", namespace)
        })
        this.handler = {}
        this.send = (channel: string, data?: any) => {
            console.log(`Received from send channel, payload size ${JSON.stringify(data).length}`, channel, data)
            socket.emit("send", { channel, data })
        }
        this.receive = (channel: string, func: any, _id?: string) => {
            this.handler[channel] = func
            console.log(`registered handler for channel ${channel}`)
            const pending_receive = this.pendingReceive[channel] || []
            pending_receive.forEach((data) => {
                func(data)
            })
            this.pendingReceive[channel] = []
        }
        this.removeListener = (_channel: string, _id: string) => {}
        this.showFilePath = (_file: File) => ""
        this.pendingReceive = {}
        socket.on("receive", ({ channel, data }) => {
            console.log(channel, data)
            const handler = this.handler[channel]
            if (handler == null) {
                const newPendingReceive = this.pendingReceive[channel] || []
                newPendingReceive.push(data)
                this.pendingReceive[channel] = newPendingReceive
            } else {
                this.handler[channel](data)
            }
        })
    }
}

const api_hooks = new APIHooks(
    io({
        // transports: ["websocket"],
    })
)
window.api = api_hooks
document.addEventListener("contextmenu", (event) => event.preventDefault())

export {}
