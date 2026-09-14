// Renderer/backend port. Electron IPC is the default adapter; other runtimes
// can implement the same contract without changing feature code.
export type BackendTransport = Window["api"]
