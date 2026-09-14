<script lang="ts">
    import { cancelMediaUpload, dismissMediaUpload, mediaUploads, retryMediaUpload } from "../../../utils/mediaUpload"
    import { translateText } from "../../../utils/language"
    import Icon from "../../helpers/Icon.svelte"
    import T from "../../helpers/T.svelte"
    import Button from "../../inputs/Button.svelte"

    // subscribes by id (instead of taking the entry object) so parents can keep
    // their item arrays referentially stable while progress ticks update the store
    export let uploadId: string
    export let mode: "grid" | "list" = "grid"

    $: upload = $mediaUploads.get(uploadId)
    $: percent = upload && upload.total > 0 ? Math.max(0, Math.min(100, Math.round((upload.loaded / upload.total) * 100))) : 0
    $: isVideo = upload?.mime.startsWith("video/") ?? false
    $: isImage = upload?.mime.startsWith("image/") ?? false
    $: icon = isVideo ? "movie" : isImage ? "image" : "music"
</script>

{#if upload}
    <div class="upload" class:list={mode === "list"} class:error={upload.status === "error"} class:complete={upload.status === "complete"}>
        <div class="preview">
            {#if upload.previewUrl && isImage}
                <img src={upload.previewUrl} alt="" draggable={false} />
            {:else if upload.previewUrl && isVideo}
                <!-- muted metadata-only so the first frame shows without playing -->
                <video src={upload.previewUrl} muted playsinline preload="metadata" />
            {:else}
                <div class="fallback-icon">
                    <Icon size={mode === "grid" ? 2.5 : 1.5} id={icon} white />
                </div>
            {/if}
            <div class="scrim" />

            <div class="status">
                {#if upload.status === "error"}
                    <Icon size={1.6} id="warning" white />
                {:else if upload.status === "complete"}
                    <Icon size={1.6} id="check" white />
                {:else if upload.status === "queued"}
                    <span class="queued"><T id="media.queued" /></span>
                {:else}
                    <span class="percent">{percent}%</span>
                {/if}
            </div>

            {#if upload.status === "uploading" || upload.status === "queued"}
                <div class="progress-bar">
                    <div class="progress-fill" style="width: {upload.status === 'queued' ? 0 : percent}%;" />
                </div>
            {/if}

            {#if upload.status !== "complete"}
                <div class="actions">
                    {#if upload.status === "uploading" || upload.status === "queued"}
                        <Button style="padding: 3px;" redHover title={translateText("media.cancel_upload")} on:click={() => cancelMediaUpload(uploadId)}>
                            <Icon id="close" size={0.9} white />
                        </Button>
                    {:else if upload.status === "error"}
                        <Button style="padding: 3px;" brighterHover title={translateText("media.retry_upload")} on:click={() => retryMediaUpload(uploadId)}>
                            <Icon id="redo" size={0.9} white />
                        </Button>
                        <Button style="padding: 3px;" redHover title={translateText("actions.close")} on:click={() => dismissMediaUpload(uploadId)}>
                            <Icon id="close" size={0.9} white />
                        </Button>
                    {/if}
                </div>
            {/if}
        </div>

        <div class="label" title={upload.status === "error" ? upload.error : upload.fileName}>
            <p class="name">{upload.fileName}</p>
            {#if upload.status === "error"}
                <p class="error-text">{upload.error || translateText("media.upload_failed")}</p>
            {/if}
        </div>
    </div>
{/if}

<style>
    .upload {
        display: flex;
        flex-direction: column;
        padding: 2px;
        width: 100%;
    }
    .upload.list {
        flex-direction: row;
        align-items: center;
        gap: 10px;
        padding: 4px 8px;
        background-color: var(--primary-darkest);
        border-radius: 4px;
    }

    .preview {
        position: relative;
        display: flex;
        justify-content: center;
        align-items: center;
        overflow: hidden;
        background-color: var(--primary);
        aspect-ratio: 16 / 9;
        border-radius: 4px;
    }
    .list .preview {
        width: 120px;
        min-width: 120px;
        aspect-ratio: 16 / 9;
    }

    .preview img,
    .preview video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        pointer-events: none;
        opacity: 0.7;
    }
    .fallback-icon {
        display: flex;
        opacity: 0.7;
    }
    .scrim {
        position: absolute;
        inset: 0;
        background-color: rgb(0 0 0 / 0.35);
        pointer-events: none;
    }

    .status {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
    }
    .percent {
        font-size: 1.4em;
        font-weight: 700;
        text-shadow: 0 1px 4px rgb(0 0 0 / 0.8);
    }
    .queued {
        font-size: 0.85em;
        font-weight: 600;
        opacity: 0.9;
        text-shadow: 0 1px 4px rgb(0 0 0 / 0.8);
    }

    .progress-bar {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 6px;
        background-color: rgb(0 0 0 / 0.5);
    }
    .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #8000f0 0%, var(--secondary) 100%);
        transition: width 0.2s ease;
    }
    .complete .progress-fill {
        background: var(--secondary);
    }

    .actions {
        position: absolute;
        top: 4px;
        right: 4px;
        display: flex;
        gap: 4px;
        background-color: rgb(0 0 0 / 0.6);
        border-radius: 4px;
    }

    .label {
        padding: 4px 2px 2px;
        min-width: 0;
        flex: 1;
    }
    .name {
        font-size: 0.85em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        opacity: 0.9;
        margin: 0;
    }
    .error-text {
        font-size: 0.75em;
        color: #ff9b9b;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin: 2px 0 0;
    }
</style>
