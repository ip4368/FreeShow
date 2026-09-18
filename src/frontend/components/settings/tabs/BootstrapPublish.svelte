<script lang="ts">
    import { onDestroy, onMount } from "svelte"
    import { get } from "svelte/store"
    import { Main } from "../../../../types/IPC/Main"
    import { ToMain } from "../../../../types/IPC/ToMain"
    import { destroyMain, receiveToMain, requestMain } from "../../../IPC/main"
    import { setRemoteServerConfig } from "../../../IPC/transport"
    import { saved } from "../../../stores"
    import { save } from "../../../utils/save"
    import Icon from "../../helpers/Icon.svelte"
    import InputRow from "../../input/InputRow.svelte"
    import Title from "../../input/Title.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"
    import MaterialTextInput from "../../inputs/MaterialTextInput.svelte"
    import MaterialToggleSwitch from "../../inputs/MaterialToggleSwitch.svelte"
    import Tip from "../../main/Tip.svelte"

    // Publish THIS machine's local library to a headless server (one-shot bootstrap).
    // Local-transport only: rendered from ServerConnection.svelte when disconnected.

    const DRAFT_KEY = "freeshow_bootstrap_draft"
    const draft = (() => {
        try {
            return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}")
        } catch {
            return {}
        }
    })()

    let url = draft.url || "http://localhost:5540"
    let token = draft.token || ""
    let destFolder = draft.destFolder || "Media"
    let audioDestFolder = draft.audioDestFolder || "Audio"
    let includeMedia = draft.includeMedia !== false
    let includeBibles = draft.includeBibles !== false
    let replace = false

    function saveDraft() {
        try {
            localStorage.setItem(DRAFT_KEY, JSON.stringify({ url, token, destFolder, audioDestFolder, includeMedia, includeBibles }))
        } catch {
            // non-fatal
        }
    }

    // remote status (replace-guard signal)
    let remoteStatus: { shows: number; bibles: number; empty: boolean } | null = null
    let statusError = ""
    let checkingStatus = false

    async function refreshStatus() {
        if (!url) return
        checkingStatus = true
        statusError = ""
        try {
            const query = token ? `?token=${encodeURIComponent(token)}` : ""
            const res = await fetch(`${url.replace(/\/+$/, "")}/bootstrap/status${query}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            remoteStatus = await res.json()
        } catch (err) {
            remoteStatus = null
            statusError = (err as Error)?.message || "unreachable"
        } finally {
            checkingStatus = false
        }
    }

    // publish
    let publishing = false
    let phase = ""
    let progress = 0
    let current = ""
    let uploadedCount = 0
    let totalCount = 0
    let result: any = null
    let error = ""

    let progressListener = ""
    onMount(() => {
        progressListener = receiveToMain(ToMain.BOOTSTRAP_PROGRESS, (data: any) => {
            phase = data?.phase || ""
            progress = data?.progress ?? progress
            current = data?.current || ""
            uploadedCount = data?.uploaded ?? uploadedCount
            totalCount = data?.total ?? totalCount
            if (phase === "done") publishing = false
        })
        void refreshStatus()
    })
    onDestroy(() => {
        if (progressListener) destroyMain(progressListener)
    })

    function phaseLabel(p: string): string {
        switch (p) {
            case "build":
                return "Building local snapshot…"
            case "restore":
                return "Uploading shows & settings…"
            case "manifest":
                return "Checking which media files are already on the server…"
            case "media":
                return totalCount ? `Uploading media (${uploadedCount}/${totalCount})…` : "Uploading media…"
            case "commit":
                return "Activating published library…"
            default:
                return ""
        }
    }

    async function publish() {
        if (!url || publishing) return
        publishing = true
        result = null
        error = ""
        phase = "build"
        progress = 0
        current = ""
        uploadedCount = 0
        totalCount = 0

        try {
            // GB uploads take a while — 30 min timeout with progress streaming back meanwhile
            const res = await requestMain(Main.BOOTSTRAP_PUBLISH, { serverUrl: url, token: token || undefined, destFolder, audioDestFolder, includeMedia, includeBibles, replace }, undefined, 30 * 60 * 1000)
            if (!res) {
                error = "No response from the local app (timed out?)."
            } else if (!res.success) {
                if (res.error === "not_empty") {
                    error = `The server already holds ${res.status?.shows ?? "?"} show(s). Enable Replace mode to overwrite it, or clear the server first.`
                    remoteStatus = res.status || remoteStatus
                } else if (res.error === "server_outdated") {
                    error = "This server is too old for staged publish. Update the headless server, then try again."
                } else {
                    error = res.error || "Publish failed."
                }
            } else {
                result = res
                void refreshStatus()
            }
        } catch (err) {
            error = (err as Error)?.message || "Publish failed."
        } finally {
            publishing = false
            if (!phase || phase === "done") phase = ""
        }
    }

    function connectNow() {
        if (!url) return
        if (!get(saved)) {
            save()
            setTimeout(() => location.reload(), 900)
        } else {
            location.reload()
        }
        setRemoteServerConfig({ enabled: true, url, token: token || undefined })
    }

    $: failedList = (result?.media?.failed || []).slice(0, 5)
    $: failedExtra = (result?.media?.failed || []).length - failedList.length
    function formatFailed(failed: { path: string; reason: string }[]): string {
        return failed.map((f) => `${f.path} (${f.reason})`).join("; ")
    }
</script>

<Title label="Publish local library to server" icon="upload" />

<MaterialTextInput
    label="Server URL"
    value={url}
    placeholder="http://localhost:5540"
    on:change={(e) => {
        url = e.detail
        saveDraft()
    }}
/>
<MaterialTextInput
    label="Token (optional)"
    value={token}
    placeholder="—"
    on:change={(e) => {
        token = e.detail
        saveDraft()
    }}
/>
<MaterialTextInput
    label="Media destination folder on the server"
    value={destFolder}
    placeholder="Media"
    on:change={(e) => {
        destFolder = e.detail
        saveDraft()
    }}
/>
<MaterialTextInput
    label="Audio destination folder on the server"
    value={audioDestFolder}
    placeholder="Audio"
    on:change={(e) => {
        audioDestFolder = e.detail
        saveDraft()
    }}
/>

<MaterialToggleSwitch label="Upload media files" title="Upload the audio/image/video files your shows reference. Files already on the server (identical content) are skipped." checked={includeMedia} defaultValue={true} on:change={(e) => ((includeMedia = e.detail), saveDraft())} />
<MaterialToggleSwitch label="Include Bibles" title="Copy your downloaded Bibles (.fsb) to the server." checked={includeBibles} defaultValue={true} on:change={(e) => ((includeBibles = e.detail), saveDraft())} />
<MaterialToggleSwitch label="Replace remote library" title="Delete everything on the server first, then publish. Without this, publishing to a non-empty server is refused." checked={replace} defaultValue={false} on:change={(e) => (replace = e.detail)} />

<InputRow>
    <MaterialButton on:click={refreshStatus} disabled={checkingStatus || !url}>{checkingStatus ? "Checking…" : "Check server"}</MaterialButton>
    <MaterialButton icon="upload" on:click={publish} style="flex: 1;" disabled={!url || publishing}>{publishing ? "Publishing…" : replace ? "Replace remote library" : "Publish to server"}</MaterialButton>
</InputRow>

{#if remoteStatus}
    <Tip type="info" value={remoteStatus.empty ? "Server is empty — ready to publish." : `Server holds ${remoteStatus.shows} show(s) and ${remoteStatus.bibles} bible(s).`} top={12} />
{:else if statusError}
    <Tip type="warning" value={"Could not reach the server (" + statusError + ")."} top={12} />
{/if}

{#if publishing && phase}
    <div class="progress">
        <p>{phaseLabel(phase)}</p>
        {#if phase === "media" && totalCount}
            <div class="bar"><div class="fill" style="width: {Math.round(progress * 100)}%;" /></div>
        {/if}
        {#if current}<p class="current">{current}</p>{/if}
    </div>
{/if}

{#if error}
    <Tip type="warning" value={error} top={12} />
{/if}

{#if result?.success}
    <div class="summary">
        <p>
            <Icon id="check" size={1} /> Published {result.shows ?? 0} show(s){result.bibles ? ` and ${result.bibles} bible(s)` : ""}{result.replaced ? " (replaced remote library)" : ""}.
        </p>
        {#if result.media}
            <p class="dim">
                Media: {result.media.uploaded} uploaded, {result.media.skipped} already present{#if result.media.failed.length}, {result.media.failed.length} failed{/if}.
            </p>
            {#if failedList.length}
                <p class="dim">Failed: {formatFailed(failedList)}{failedExtra > 0 ? ` (+${failedExtra} more)` : ""}</p>
            {/if}
        {/if}
        <InputRow>
            <MaterialButton icon="login" on:click={connectNow} style="flex: 1;">Connect to this server now</MaterialButton>
        </InputRow>
    </div>
{/if}

<Tip value="Your shows keep working locally. Files outside your FreeShow data folder are collected into the destination folders above (audio into the audio folder, everything else into the media folder)." top={15} />

<style>
    .progress {
        margin-top: 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .progress p {
        margin: 0;
    }
    .current {
        opacity: 0.6;
        font-size: 0.85em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .bar {
        height: 6px;
        background: var(--primary-lighter);
        border-radius: 3px;
        overflow: hidden;
    }
    .fill {
        height: 100%;
        background: var(--connected);
        transition: width 0.2s;
    }
    .summary {
        margin-top: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .summary p {
        margin: 0;
    }
    .dim {
        opacity: 0.75;
        font-size: 0.9em;
    }
</style>
