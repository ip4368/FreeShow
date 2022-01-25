export interface ClientMessage {
  channel: ClientChannels
  id?: DeviceID
  data?: any
}

type DeviceID = string
type ClientChannels = "CONNECTION" | "DISCONNECT" | "ERROR" | "DATA" | "PASSWORD" | "ACCESS" | "SHOWS" | "SHOW" | "SLIDES" | "PROJECTS" | "OUT"

export interface MainData {
  channel: MainChannels
  data?: any
}
type MainChannels = "GET_OS" | "OUTPUT" | "DISPLAY"
