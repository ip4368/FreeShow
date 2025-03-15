class APIHooks {
    handler: { [key: string]: any }
    send: (_channel: string, _data?: any) => void
    receive: (channel: string, func: any, _id?: string) => void
    removeListener: (_channel: string, _id: string) => void
    showFilePath: (_file: File) => string

    constructor() {
        this.handler = {}
        this.send = (channel: string, data?: any) => {
            console.log("Received from send channel", channel, data)
        }
        this.receive = (channel: string, func: any, _id?: string) => {
            this.handler[channel] = func
            console.log(`registered handler for channel ${channel}`)
            setTimeout(() => {
                this.handler.STARTUP({ channel: "TYPE", data: "main" })
            }, 0)
        }
        this.removeListener = (_channel: string, _id: string) => {}
        this.showFilePath = (_file: File) => ""
    }
}

const api_hooks = new APIHooks()
window.api = api_hooks
document.addEventListener("contextmenu", (event) => event.preventDefault())

export {}
