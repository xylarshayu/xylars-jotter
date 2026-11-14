<script lang="ts">
  import { app } from "../lib/app.svelte.ts"
  import Icon from "./Icon.svelte"
</script>

<div class="lightbox" role="dialog" aria-modal="true" aria-label="Image">
  <button class="close" aria-label="Close image" onclick={() => (app.lightbox = null)}>
    <Icon name="x" />
  </button>
  <button class="frame" aria-label="Close image" onclick={() => (app.lightbox = null)}>
    <img src={app.lightbox} alt="" />
  </button>
</div>

<style>
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgb(0 0 0 / 0.88);
    display: grid;
    place-items: center;
  }
  .frame {
    border: 0;
    background: none;
    padding: 16px;
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
  }
  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 6px;
  }
  .close {
    position: absolute;
    top: calc(12px + env(safe-area-inset-top));
    right: 12px;
    width: var(--tap);
    height: var(--tap);
    border-radius: 50%;
    border: 0;
    color: #fff;
    background: rgb(255 255 255 / 0.12);
    display: grid;
    place-items: center;
    z-index: 1;
  }
</style>
