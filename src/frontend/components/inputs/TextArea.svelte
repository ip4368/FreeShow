<textarea class="edit" placeholder={$$props.placeholder || null} value={$$props.value} style={$$props.style} class:center={$$props.center} on:input />

<!-- <div class="edit" style={$$props.style} class:center={$$props.center} contenteditable>
  {$$props.value}
</div> -->
<style>
    textarea {
        background-color: var(--primary-darker);
        border-radius: var(--border-radius);
        color: var(--text);
        height: 100%;
        width: 100%;
        font-family: inherit;
        font-size: inherit;
        font-weight: inherit;
        border: 0;
        padding: 10px;
        outline-offset: -2px;
        resize: none;
    }
    textarea.center {
        text-align: center;
    }
    textarea:hover {
        background-color: var(--hover);
    }

    textarea::placeholder {
        color: var(--text);
        opacity: 0.3;
    }
</style>
