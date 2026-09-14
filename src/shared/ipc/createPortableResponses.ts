import { Main } from "../../types/IPC/channels"
import { unzipBuffer } from "../data/zip"
import type { PersistenceAdapter, Platform, RestoreResult, TrashAdapter } from "../platform/Platform"

type CorePortableChannel =
    | Main.LOG
    | Main.IS_DEV
    | Main.GET_CACHE_PATH
    | Main.VERSION
    | Main.GET_OS
    | Main.DEVICE_ID
    | Main.GET_DEVICE_NAME
    | Main.IP
    | Main.CHECK_RAM_USAGE
    | Main.SETTINGS
    | Main.SYNCED_SETTINGS
    | Main.STAGE
    | Main.PROJECTS
    | Main.OVERLAYS
    | Main.TEMPLATES
    | Main.EVENTS
    | Main.MEDIA
    | Main.THEMES
    | Main.DRIVE_API_KEY
    | Main.HISTORY
    | Main.USAGE
    | Main.CACHE
    | Main.GET_STORE_VALUE
    | Main.SET_STORE_VALUE
    | Main.SAVE
    | Main.BIBLE
    | Main.SHOW
    | Main.SHOWS
    | Main.FULL_SHOWS_LIST
    | Main.READ_BIBLES_FOLDER
    | Main.GET_PATHS
    | Main.DATA_PATH
    | Main.READ_FOLDER
    | Main.READ_FILE
    | Main.CREATE_FOLDER

interface PortablePayloads {
    [Main.LOG]: unknown
    [Main.GET_STORE_VALUE]: Parameters<PersistenceAdapter["getStoreValue"]>[0]
    [Main.SET_STORE_VALUE]: Parameters<PersistenceAdapter["setStoreValue"]>[0]
    [Main.SAVE]: Parameters<PersistenceAdapter["save"]>[0]
    [Main.BIBLE]: Parameters<PersistenceAdapter["loadScripture"]>[0]
    [Main.SHOW]: Parameters<PersistenceAdapter["loadShow"]>[0]
    [Main.READ_FOLDER]: Parameters<PersistenceAdapter["readFolderContent"]>[0]
    [Main.READ_FILE]: { path: string }
    [Main.CREATE_FOLDER]: Parameters<PersistenceAdapter["createFolder"]>[0]
}

export type PortableHandler<ID extends CorePortableChannel> = ID extends keyof PortablePayloads ? (data: PortablePayloads[ID]) => any : () => any

interface OptionalPortableResponses {
    [Main.RESTORE_UPLOAD]?: (value: ArrayBuffer | Uint8Array) => Promise<RestoreResult>
    [Main.BACKUP_DOWNLOAD]?: () => Promise<Buffer>
    [Main.TRASH_FILES]?: TrashAdapter["trashFiles"]
    [Main.TRASH_RESTORE]?: TrashAdapter["restoreTrash"]
    [Main.TRASH_DELETE]?: TrashAdapter["deleteTrash"]
    [Main.TRASH_EMPTY]?: TrashAdapter["emptyTrash"]
    [Main.TRASH_LIST]?: TrashAdapter["listTrash"]
    [Main.MEDIA_USAGE]?: TrashAdapter["findMediaUsage"]
}

export type PortableResponses = { [ID in CorePortableChannel]: PortableHandler<ID> } & OptionalPortableResponses

/**
 * Create Main-channel handlers shared by runtime adapters.
 * Environment-specific code stays behind Platform instead of being duplicated
 * in each transport server.
 */
export function createPortableResponses(platform: Platform) {
    const { data } = platform

    return {
        [Main.LOG]: (value) => console.info(value),
        [Main.IS_DEV]: () => platform.isDevelopment(),
        [Main.GET_CACHE_PATH]: () => platform.getCachePath(),
        [Main.VERSION]: () => platform.getVersion(),
        [Main.GET_OS]: () => platform.getOS(),
        [Main.DEVICE_ID]: () => platform.getDeviceId(),
        [Main.GET_DEVICE_NAME]: () => platform.getDeviceName(),
        [Main.IP]: () => platform.getLocalIPs(),
        [Main.CHECK_RAM_USAGE]: () => platform.checkRamUsage(),

        [Main.SETTINGS]: () => data.getStore("SETTINGS"),
        [Main.SYNCED_SETTINGS]: () => data.getStore("SYNCED_SETTINGS"),
        [Main.STAGE]: () => data.getStore("STAGE"),
        [Main.PROJECTS]: () => data.getStore("PROJECTS"),
        [Main.OVERLAYS]: () => data.getStore("OVERLAYS"),
        [Main.TEMPLATES]: () => data.getStore("TEMPLATES"),
        [Main.EVENTS]: () => data.getStore("EVENTS"),
        [Main.MEDIA]: () => data.getStore("MEDIA"),
        [Main.THEMES]: () => data.getStore("THEMES"),
        [Main.DRIVE_API_KEY]: () => data.getStore("DRIVE_API_KEY"),
        [Main.HISTORY]: () => data.getStore("HISTORY"),
        [Main.USAGE]: () => data.getStore("USAGE"),
        [Main.CACHE]: () => data.getStore("CACHE"),
        [Main.GET_STORE_VALUE]: (value) => data.getStoreValue(value),
        [Main.SET_STORE_VALUE]: (value) => data.setStoreValue(value),

        [Main.SAVE]: (value) => data.save(value),
        [Main.BIBLE]: (value) => data.loadScripture(value),
        [Main.SHOW]: (value) => data.loadShow(value),
        [Main.SHOWS]: () => data.loadShows(),
        [Main.FULL_SHOWS_LIST]: () => data.loadAllShows(),
        [Main.READ_BIBLES_FOLDER]: () => data.readBiblesFolder(),
        [Main.GET_PATHS]: () => data.getPaths(),
        [Main.DATA_PATH]: () => data.getDataFolderRoot(),
        [Main.READ_FOLDER]: (value) => data.readFolderContent(value),
        [Main.READ_FILE]: (value) => ({ content: data.readFile(value.path) }),
        [Main.CREATE_FOLDER]: (value) => data.createFolder(value),

        ...(data.backup
            ? {
                  [Main.RESTORE_UPLOAD]: async (value: any) => {
                      try {
                          const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
                          const entries = await unzipBuffer(buffer)
                          return data.backup!.restoreEntries(entries)
                      } catch (err) {
                          console.error("Failed to restore upload:", err)
                          return { finished: false, error: (err as Error)?.message || "restore_failed" }
                      }
                  },
                  [Main.BACKUP_DOWNLOAD]: () => data.backup!.buildBackupZip()
              }
            : {}),

        ...(data.trash
            ? {
                  [Main.TRASH_FILES]: (value: any) => data.trash!.trashFiles(value),
                  [Main.TRASH_RESTORE]: (value: any) => data.trash!.restoreTrash(value),
                  [Main.TRASH_DELETE]: (value: any) => data.trash!.deleteTrash(value),
                  [Main.TRASH_EMPTY]: () => data.trash!.emptyTrash(),
                  [Main.TRASH_LIST]: () => data.trash!.listTrash(),
                  [Main.MEDIA_USAGE]: (value: any) => data.trash!.findMediaUsage(value)
              }
            : {})
    } satisfies PortableResponses
}
