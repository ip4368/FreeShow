<script lang="ts">
    import { cancelMediaUpload, dismissMediaUpload, mediaUploads, retryMediaUpload } from "../../../utils/mediaUpload"
    import { translateText } from "../../../utils/language"
    import Icon from "../../helpers/Icon.svelte"
    import T from "../../helpers/T.svelte"
    import Button from "../../inputs/Button.svelte"

    // subscribes by id (instead of taking the entry object) so parents can keep
    // their item arrays referentially stable while progress ticks update the store
    export let uploadId: string

    $: upload = $mediaUploads.get(uploadId)
    $: percent = upload && upload.total > 0 ? Math.max(0, Math.min(100, Math.round((upload.loaded / upload.total) * 100))) : 0
</script>

{#if upload}
    <div class="upload-row" class:error={upload.status === "error"} title={upload.status === "error" ? upload.error : upload.fileName}>
        <span class="main">
            {#if upload.status === "error"}
                <Icon id="warning" white right />
            {:else if upload.status === "complete"}
                <Icon id="check" white right />
            {:else}
                <Icon id="music" white right />
            {/if}
            <p class="name">{upload.fileName}</p>
        </span>

        <span class="progress">
            {#if upload.status === "queued"}
                <span class="status-text"><T id="media.queued" /></span>
            {:else if upload.status === "error"}
                <span class="status-text error-text">{upload.error || translateText("media.upload_failed")}</span>
            {:else}
                <div class="progress-bar">
                    <div class="progress-fill" style="width: {percent}%;" />
                </div>
                <span class="status-text">{percent}%</span>
            {/if}

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
        </span>
    </div>
{/if}

<style>
    .upload-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        width: 100%;
        padding: 6px 15px;
        font-size: 0.9em;
        background-color: var(--primary-darkest);
        border-radius: 4px;
    }

    .main {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        flex: 1;
    }
    .name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        opacity: 0.9;
        margin: 0;
    }

    .progress {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }
    .progress-bar {
        width: 120px;
        height: 6px;
        background-color: var(--primary);
        border-radius: 3px;
        overflow: hidden;
    }
    .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #8000f0 0%, var(--secondary) 100%);
        transition: width 0.2s ease;
        border-radius: 3px;
    }
    .status-text {
        font-size: 0.85em;
        opacity: 0.8;
        white-space: nowrap;
    }
    .error-text {
        color: #ff9b9b;
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
    }
</style>
