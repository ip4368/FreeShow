<script lang="ts">
    import { onDestroy } from "svelte"
    import { uid } from "uid"
    import { Main } from "../../../../types/IPC/Main"
    import { destroyMain, receiveMain, sendMain } from "../../../IPC/main"
    import { AudioPlaylist } from "../../../audio/audioPlaylist"
    import { activePlaylist, activeRename, audioFolders, audioPlaylists, dictionary, drawerTabsData, effectsLibrary, labelsDisabled, media, outLocked, selectAllAudio, selected } from "../../../stores"
    import Icon from "../../helpers/Icon.svelte"
    import T from "../../helpers/T.svelte"
    import { clone, sortByName } from "../../helpers/array"
    import { splitPath } from "../../helpers/get"
    import { getFileName, getMediaType } from "../../helpers/media"
    import Button from "../../inputs/Button.svelte"
    import CombinedInput from "../../inputs/CombinedInput.svelte"
    import NumberInput from "../../inputs/NumberInput.svelte"
    import Center from "../../system/Center.svelte"
    import DropArea from "../../system/DropArea.svelte"
    import AudioStreams from "../live/AudioStreams.svelte"
    import Microphones from "../live/Microphones.svelte"
    import Folder from "../media/Folder.svelte"
    import AudioEffect from "./AudioEffect.svelte"
    import AudioFile from "./AudioFile.svelte"

    export let active: string | null
    export let searchValue: string = ""

    type File = { path: string; name: string; extension?: string; folder?: boolean; favourite?: boolean; audio?: boolean }

    let files: File[] = []
    let scrollElem: HTMLElement | undefined

    let playlistSettings: boolean = false

    $: playlist = active && $audioPlaylists[active]

    $: isDefault = ["all", "favourites", "effects_library", "microphones", "audio_streams"].includes(active || "")
    $: rootPath = isDefault || playlist ? "" : active !== null ? $audioFolders[active]?.path! || "" : ""
    $: path = isDefault || playlist ? "" : rootPath
    $: name =
        active === "all"
            ? "category.all"
            : active === "favourites"
              ? "category.favourites"
              : active === "effects_library"
                ? "category.sound_effects"
                : rootPath === path
                  ? active !== "microphones" && active !== "audio_streams" && active !== null
                      ? $audioFolders[active]?.name || ""
                      : ""
                  : splitPath(path).name

    // get list of files & folders
    let prevActive: null | string = null
    $: {
        if (active === "favourites") {
            prevActive = active
            files = Object.entries($media)
                .map(([path, a]) => {
                    let p = splitPath(path)
                    let name = p.name
                    return { path, favourite: a.favourite === true, name, extension: p.extension, audio: a.audio === true }
                })
                .filter((a) => a.favourite === true && a.audio === true)

            // filterFiles()
            scrollElem?.scrollTo(0, 0)
        } else if (active === "effects_library") {
            prevActive = active
            files = clone($effectsLibrary)

            scrollElem?.scrollTo(0, 0)
        } else if (active === "all") {
            if (active !== prevActive) {
                prevActive = active
                files = []
                Object.values($audioFolders).forEach((data) => sendMain(Main.READ_FOLDER, { path: data.path!, disableThumbnails: true }))
            }
        } else if (path.length) {
            if (path !== prevActive) {
                prevActive = path
                files = []
                sendMain(Main.READ_FOLDER, { path, listFilesInFolders: true, disableThumbnails: true })
            }
        } else {
            // microphones & audio_streams
            prevActive = active
        }
    }

    let filesInFolders: { id: string; name: string }[] = []
    let folderFiles: { [key: string]: string[] } = {}

    let listenerId = receiveMain(Main.READ_FOLDER, (data) => {
        filesInFolders = sortByName(data.filesInFolders || [])

        if (active !== "all" && data.path !== path) return

        files.push(...data.files.filter((file) => getMediaType(file.extension) === "audio" || (active !== "all" && file.folder)))
        files = sortByName(files).sort((a, b) => (a.folder === b.folder ? 0 : a.folder ? -1 : 1))

        files = files.map((a) => ({ ...a, path: a.folder ? a.path : a.path }))

        // set valid files in folder
        folderFiles = {}
        Object.keys(data.folderFiles).forEach((path) => {
            folderFiles[path] = data.folderFiles[path].filter((file) => file.folder || getMediaType(file.extension) === "audio")
        })

        // remove folders with no content
        files = files.filter((a) => !a.folder || !folderFiles[a.path] || folderFiles[a.path].length > 0)

        // filterFiles()
        scrollElem?.scrollTo(0, 0)
    })
    onDestroy(() => destroyMain(listenerId))

    // search
    $: if (searchValue !== undefined || files) filterSearch()
    const filter = (s: string) => s.toLowerCase().replace(/[.,\/#!?$%\^&\*;:{}=\-_`~()]/g, "")
    let fullFilteredFiles: any[] = []
    function filterSearch() {
        fullFilteredFiles = clone(files)
        if (searchValue.length > 1) fullFilteredFiles = [...fullFilteredFiles, ...filesInFolders].filter((a) => filter(a.name).includes(filter(searchValue)))

        // scroll to top
        document.querySelector("svelte-virtual-list-viewport")?.scrollTo(0, 0)
    }

    function keydown(e: KeyboardEvent) {
        // if (e.key === "Enter" && searchValue.length > 1 && e.target.closest(".search")) {
        //   if (fullFilteredFiles.length) {
        //     let file = fullFilteredFiles[0]
        //     activeShow.set({ id: file.path, name: file.name, type: $videoExtensions.includes(file.extension) ? "video" : "image" })
        //     activeFile = filteredFiles.findIndex((a) => a.path === file.path)
        //     if (activeFile < 0) activeFile = null
        //   }
        // }

        if (e.target?.closest("input") || e.target?.closest(".edit")) return

        if ((e.ctrlKey || e.metaKey) && e.key === "Backspace") {
            if (rootPath === path) return
            goBack()
        }
    }

    function goBack() {
        const lastSlash = path.lastIndexOf("\\") > -1 ? path.lastIndexOf("\\") : path.lastIndexOf("/")
        const folder = path.slice(0, lastSlash)
        path = folder.length > rootPath.length ? folder : rootPath
    }

    // selected will be cleared when clicked, so store them on mousedown
    let selectedFiles: File[] = []
    function storeSelected() {
        if ($selected.id === "audio") selectedFiles = clone($selected.data)
        else selectedFiles = []
    }

    function createPlaylist(e) {
        let playlistName = ""
        let files = fullFilteredFiles.filter((a) => !a.folder)
        if (selectedFiles.length) files = selectedFiles

        if (e.ctrlKey || e.metaKey) {
            files = []
        } else if (!isDefault) {
            playlistName = name
            if (name.includes(".")) playlistName = $dictionary.category?.[name.slice(name.indexOf(".") + 1)] || ""
        }

        let playlistId = uid()
        audioPlaylists.update((a) => {
            a[playlistId] = {
                name: playlistName,
                songs: files.map((a) => a.path),
            }

            return a
        })

        drawerTabsData.update((a) => {
            a.audio.activeSubTab = playlistId
            return a
        })

        if (!playlistName || !files.length) {
            activeRename.set("category_audio_" + playlistId)
        }
    }

    // select all
    $: if ($selectAllAudio) selectAll()
    function selectAll() {
        let data = (playlist ? playlist.songs : fullFilteredFiles)
            .filter((a) => (playlist ? true : a.extension))
            .map((file, index) => {
                if (playlist) return { path: file, name: getFileName(file), index }
                return { path: file.path, name: file.name, index: -1 }
            })

        selected.set({ id: "audio", data })
        selectAllAudio.set(false)
    }
</script>

<svelte:window on:keydown={keydown} />

<div class="scroll" style="flex: 1;overflow-y: auto;" bind:this={scrollElem}>
    <div class="grid" style="height: 100%;">
        {#if active === "microphones"}
            <Microphones />
        {:else if active === "audio_streams"}
            <AudioStreams />
        {:else if playlist && playlistSettings}
            <CombinedInput>
                <p><T id="settings.audio_crossfade" /></p>
                <NumberInput value={playlist?.crossfade || 0} max={30} step={0.5} decimals={1} fixed={1} on:change={(e) => AudioPlaylist.update(active || "", "crossfade", e.detail)} />
            </CombinedInput>

            <CombinedInput>
                <p><T id="settings.playlist_volume" /></p>
                <NumberInput value={playlist?.volume || 1} min={0.01} max={1} decimals={2} step={0.01} inputMultiplier={100} on:change={(e) => AudioPlaylist.update(active || "", "volume", e.detail)} />
            </CombinedInput>

            <!-- <CombinedInput>
                <p><T id="settings.custom_audio_output" /></p>
                <Dropdown options={audioOutputs} value={audioOutputs.find((a) => a.id === $special.audioOutput)?.name || "—"} on:click={(e) => updateSpecial(e.detail.id, "audioOutput")} />
            </CombinedInput> -->
        {:else if playlist}
            <DropArea id="audio_playlist" selectChildren let:fileOver file>
                {#if playlist.songs.length}
                    {#each playlist.songs as song, index}
                        <AudioFile path={song} name={getFileName(song)} {active} playlist {index} {fileOver} />
                    {/each}
                {:else}
                    <Center faded>
                        <T id="empty.general" />
                    </Center>
                {/if}
            </DropArea>
        {:else if active === "effects_library"}
            <div class="effects">
                {#each fullFilteredFiles as file}
                    <AudioEffect path={file.path} name={file.name} />
                {/each}
            </div>
        {:else if fullFilteredFiles.length}
            {#key rootPath}
                {#key path}
                    {#each fullFilteredFiles as file}
                        {#if file.folder}
                            <Folder bind:rootPath={path} name={file.name} path={file.path} mode="list" />
                        {:else}
                            <AudioFile path={file.path} name={file.name} {active} />
                        {/if}
                    {/each}
                {/key}
            {/key}
        {:else}
            <Center style="opacity: 0.2;">
                <Icon id="noAudio" size={5} white />
            </Center>
        {/if}
    </div>
</div>

{#if active !== "microphones" && active !== "audio_streams" && active !== "effects_library"}
    <div class="tabs" style="display: flex;align-items: center;" on:mousedown={storeSelected}>
        {#if isDefault}
            <span style="padding: 0.2em;opacity: 0;">.</span>
        {:else if playlist}
            <Button
                disabled={$outLocked}
                title={$activePlaylist?.id === active ? $dictionary.media?.stop : $dictionary.media?.play}
                on:click={() => {
                    if ($outLocked) return
                    $activePlaylist?.id === active ? AudioPlaylist.stop() : AudioPlaylist.start(active || "")
                }}
            >
                <Icon size={1.3} id={$activePlaylist?.id === active ? "stop" : "play"} white={$activePlaylist?.id === active} />
            </Button>

            <div class="seperator" />

            <Button
                title={$dictionary.media?.toggle_shuffle}
                on:click={() => {
                    if (!active) return
                    AudioPlaylist.update(active, "mode", $audioPlaylists[active]?.mode === "shuffle" ? "default" : "shuffle")
                    // if ($activePlaylist?.id === active) playlistNext("", $activePlaylist.active)
                }}
            >
                <Icon size={1.1} id="shuffle_play" white={$audioPlaylists[active || ""]?.mode !== "shuffle"} />
            </Button>
            <Button
                title={$dictionary.media?._loop}
                on:click={() => {
                    if (!active) return
                    AudioPlaylist.update(active, "loop", $audioPlaylists[active]?.loop === undefined ? false : !$audioPlaylists[active]?.loop)
                }}
            >
                <Icon size={1.1} id="loop" white={$audioPlaylists[active || ""]?.loop === false} />
            </Button>
        {:else}
            <Button disabled={rootPath === path} title={$dictionary.actions?.back} on:click={goBack}>
                <Icon size={1.3} id="back" />
            </Button>
        {/if}
        <!-- <Button disabled={rootPath === path} title={$dictionary.actions?.home} on:click={() => (path = rootPath)}>
            <Icon size={1.3} id="home" />
        </Button> -->
        <span style="flex: 1;text-align: center;">
            {#key name}
                {#if name?.includes(".")}
                    <T id={name} />
                {:else if playlist}
                    {playlist.name}
                {:else}
                    {name}
                {/if}
            {/key}
        </span>

        {#if !playlist}
            <Button title={$dictionary.new?.playlist} on:click={createPlaylist}>
                <Icon size={1.2} id="playlist_create" right={!$labelsDisabled} />
                {#if !$labelsDisabled}<p><T id="new.playlist" /></p>{/if}
            </Button>
        {:else}
            <Button active={playlistSettings === true} title={$dictionary.audio?.playlist_settings} on:click={() => (playlistSettings = !playlistSettings)}>
                <Icon size={1.1} id="options" right={!$labelsDisabled} white={playlistSettings} />
                {#if !$labelsDisabled}<p><T id="audio.playlist_settings" /></p>{/if}
            </Button>
        {/if}
    </div>
{/if}

<style>
    .tabs {
        display: flex;
        background-color: var(--primary-darkest);
    }

    .grid {
        display: flex;
        flex-direction: column;
        /* flex-wrap: wrap; */
        flex: 1;
        /* gap: 10px;
    padding: 10px; */
        /* padding: 5px; */
        place-content: flex-start;
    }

    .grid :global(button) {
        /* font-size: 1em; */
        padding: 6px 15px;

        justify-content: space-between;
    }
    .grid :global(.selectElem:not(.isSelected):nth-child(even)) {
        background-color: rgb(0 0 20 / 0.08);
    }

    .effects {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        gap: 5px;

        height: 100%;
        margin: 10px;
    }
    .effects :global(.selectElem button) {
        background-color: var(--primary-darkest);
        /* transition: 0.2s outline; */
    }

    .seperator {
        width: 1px;
        height: 100%;
        background-color: var(--primary);
    }
</style>
