<script lang="ts">
  import ContextChild from "./ContextChild.svelte"
  import ContextItem from "./ContextItem.svelte"
  import { contextMenuItems, contextMenuLayouts } from "./contextMenus"

  let contextElem: any = null
  let contextActive: boolean = false
  let activeMenu: string[]
  let x: number = 0
  let y: number = 0
  let side: "right" | "left" = "right"
  let translate = 0
  function contextMenu(e: MouseEvent) {
    if (!e.target?.closest(".contextMenu") && !e.target?.closest(".nocontext")) {
      contextElem = e.target!.closest(".context") || document.body

      x = e.clientX
      y = e.clientY
      translate = 0
      activeMenu = contextMenuLayouts.default
      let c = contextElem?.classList.length ? [...contextElem?.classList].find((c: string) => c.includes("#")) : null
      if (c?.includes("__")) {
        let menus = c.slice(1, c.length).split("__")
        if (contextMenuLayouts[menus[1]]) {
          activeMenu = []
          menus.forEach((c2: string, i: number) => {
            activeMenu.push(...contextMenuLayouts[c2])
            if (i < menus.length - 1) activeMenu.push("SEPERATOR")
          })
        }
      } else if (c && contextMenuLayouts[c.slice(1, c.length)]) activeMenu = contextMenuLayouts[c.slice(1, c.length)]

      let contextHeight = Object.keys(activeMenu).length * 30 + 10
      if (x + 250 > window.innerWidth) x -= 250
      if (y + contextHeight > window.innerHeight) translate = 100
      if (x + (250 + 150) > window.innerWidth) side = "left"
      else side = "right"

      contextActive = true
    } else contextActive = false
  }

  const click = (e: MouseEvent) => {
    if (!e.target?.closest(".contextMenu")) contextActive = false
  }
</script>

<svelte:window on:contextmenu={contextMenu} on:click={click} />

{#if contextActive}
  <div class="contextMenu" style="left: {x}px; top: {y}px;transform: translateY(-{translate}%);">
    {#key activeMenu}
      {#each activeMenu as id}
        {#if id === "SEPERATOR"}
          <hr />
        {:else if contextMenuItems[id]?.items}
          <ContextChild {id} {contextElem} bind:contextActive {side} />
        {:else}
          <ContextItem {id} {contextElem} bind:contextActive />
        {/if}
      {/each}
    {/key}
  </div>
{/if}

<style>
  .contextMenu {
    position: fixed;
    min-width: 250px;
    background-color: var(--primary);
    box-shadow: 1px 1px 3px 2px rgb(0 0 0 / 0.2);
    padding: 5px 0;
    z-index: 80;
  }

  hr {
    margin: 5px 10px;
    height: 2px;
    border: none;
    background-color: var(--primary-lighter);
  }
</style>