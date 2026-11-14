<script lang="ts">
  import { app } from "./lib/app.svelte.ts"
  import Composer from "./components/Composer.svelte"
  import Feed from "./components/Feed.svelte"
  import ContextMenu from "./components/ContextMenu.svelte"
  import Lightbox from "./components/Lightbox.svelte"
  import PairDevice from "./components/PairDevice.svelte"
  import PairNew from "./components/PairNew.svelte"
  import SettingsView from "./components/Settings.svelte"
  import Setup from "./components/Setup.svelte"
  import Sidebar from "./components/Sidebar.svelte"
  import Toasts from "./components/Toasts.svelte"
  import TopBar from "./components/TopBar.svelte"

  // Files dropped anywhere go to the composer, any type (ADR-0017). Without this, a drop
  // outside the composer would make the browser navigate to the file.
  const dragsFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files")
  function ondragover(e: DragEvent) {
    if (dragsFiles(e)) e.preventDefault()
  }
  function ondrop(e: DragEvent) {
    if (!dragsFiles(e)) return
    e.preventDefault()
    const files = [...(e.dataTransfer?.files ?? [])]
    if (app.phase === "ready" && !app.editing && files.length)
      app.draftFiles = [...app.draftFiles, ...files]
  }

  function onkeydown(e: KeyboardEvent) {
    if (app.phase !== "ready") return
    const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select")
    if (e.key === "Escape") {
      if (app.menu) app.menu = null
      else if (app.lightbox) app.lightbox = null
      else if (app.selected) app.selected = null
      else if (app.panel) app.panel = null
      else if (app.drawer) app.drawer = false
      else if (app.searching) app.closeSearch()
      else if (app.editing) app.cancelEdit()
    } else if (!typing && (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key === "k"))) {
      e.preventDefault()
      app.openSearch()
    }
  }
</script>

<svelte:window {onkeydown} {ondragover} {ondrop} />

{#if app.phase === "loading"}
  <div class="splash" aria-busy="true"></div>
{:else if app.phase === "failed"}
  <div class="splash">
    <p>This browser won't let Jotter store data. Private browsing can do this.</p>
  </div>
{:else if app.phase === "setup"}
  <Setup />
{:else}
  <div class="shell" class:drawer-open={app.drawer}>
    <Sidebar />
    <button class="scrim" tabindex="-1" aria-label="Close menu" onclick={() => (app.drawer = false)}
    ></button>
    <main>
      <TopBar />
      {#if app.needsLogin && !app.repairing}
        <div class="banner" role="status">
          {#if app.needsLogin === "pair"}
            <span>This device's session ended.</span>
            <button class="btn small" onclick={() => (app.repairing = true)}>Pair again</button>
          {:else}
            <span>Your session expired.</span>
            <button class="btn small" onclick={() => app.signIn()}>Sign in</button>
          {/if}
        </div>
      {/if}
      {#if app.repairing}
        <div class="repair">
          <PairNew temporary={app.temporary} onclose={() => (app.repairing = false)} />
        </div>
      {:else if app.route.view === "settings"}
        <SettingsView />
      {:else if app.route.view === "pair"}
        <PairDevice />
      {:else}
        <Feed />
        <Composer />
      {/if}
    </main>
  </div>
  <Toasts />
  {#if app.lightbox}<Lightbox />{/if}
  {#if app.menu}<ContextMenu {...app.menu} />{/if}
{/if}

<style>
  .splash {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 24px;
    color: var(--muted);
    text-align: center;
  }
  .shell {
    height: 100dvh;
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
  }
  main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100dvh;
    position: relative;
  }
  .scrim {
    display: none;
  }
  .repair {
    flex: 1;
    overflow-y: auto;
    width: min(100%, 460px);
    margin: 0 auto;
    padding: 16px;
    display: grid;
    align-content: start;
    gap: 14px;
  }
  .banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 8px 16px;
    background: var(--lock-soft);
    color: var(--text);
    font-size: 0.9rem;
  }
  @media (max-width: 899px) {
    .shell {
      grid-template-columns: minmax(0, 1fr);
    }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 30;
      border: 0;
      background: rgb(0 0 0 / 0.35);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s ease;
    }
    .drawer-open .scrim {
      opacity: 1;
      pointer-events: auto;
    }
  }
</style>
