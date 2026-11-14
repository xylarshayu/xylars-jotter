<script lang="ts">
  import { app } from "../lib/app.svelte.ts"
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each app.toasts as t (t.id)}
    <div class="toast" class:error={t.kind === "error"}>{t.text}</div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: calc(96px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    display: grid;
    gap: 8px;
    z-index: 50;
    width: min(92vw, 420px);
    pointer-events: none;
  }
  .toast {
    justify-self: center;
    background: var(--text);
    color: var(--bg);
    padding: 10px 16px;
    border-radius: 999px;
    font-size: 0.92rem;
    box-shadow: var(--shadow-lg);
    white-space: pre-line;
    text-align: center;
    animation: rise 0.16s ease-out;
  }
  .toast.error {
    background: var(--danger);
    color: #fff;
    border-radius: 14px;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
</style>
