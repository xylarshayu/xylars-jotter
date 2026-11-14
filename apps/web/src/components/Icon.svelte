<script lang="ts" module>
  const ICONS: Record<string, { d: string[]; fill?: boolean }> = {
    menu: { d: ["M4 7h16M4 12h16M4 17h16"] },
    search: { d: ["M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13Z", "M20 20l-4.2-4.2"] },
    x: { d: ["M6 6l12 12M18 6L6 18"] },
    send: { d: ["M12 19V5M6 11l6-6 6 6"] },
    image: { d: ["M4.5 5.5h15v13h-15z", "M4.5 15.5l4.5-4.5 4 4 2.5-2.5 4 4", "M15 8.5h.01"] },
    copy: { d: ["M9 9h10v10H9z", "M5 15V5h10"] },
    check: { d: ["M5 12.5l4.5 4.5L19 7.5"] },
    lock: { d: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"] },
    unlock: { d: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 6.9-.8"] },
    more: {
      fill: true,
      d: [
        "M6 10.4a1.6 1.6 0 1 1 0 3.2a1.6 1.6 0 1 1 0-3.2Z",
        "M12 10.4a1.6 1.6 0 1 1 0 3.2a1.6 1.6 0 1 1 0-3.2Z",
        "M18 10.4a1.6 1.6 0 1 1 0 3.2a1.6 1.6 0 1 1 0-3.2Z",
      ],
    },
    edit: { d: ["M4.5 19.5h4l10-10-4-4-10 10z", "M13 7l4 4"] },
    move: { d: ["M4 12h11M11 7l5 5-5 5", "M20 5v14"] },
    history: { d: ["M12 7.5V12l3 2", "M4.6 13a7.5 7.5 0 1 0 1.9-6.2", "M4.5 4v4h4"] },
    trash: { d: ["M5 7h14", "M10 7V5h4v2", "M7 7l1 12h8l1-12"] },
    plus: { d: ["M12 5v14M5 12h14"] },
    sun: {
      d: [
        "M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7Z",
        "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4",
      ],
    },
    moon: { d: ["M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z"] },
    system: { d: ["M4 5h16v11H4z", "M9 20h6M12 16v4"] },
    offline: {
      d: [
        "M3 3l18 18",
        "M7.5 9A4.5 4.5 0 0 0 7 18h10.5",
        "M10.5 6.3A5 5 0 0 1 17 9.5a3.8 3.8 0 0 1 3 6.2",
      ],
    },
    clock: { d: ["M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16Z", "M12 8v4l2.5 1.5"] },
    link: {
      d: [
        "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1",
        "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
      ],
    },
    settings: { d: ["M4 7h9M17 7h3M4 17h3M11 17h9", "M15 5v4M9 15v4"] },
    hash: { d: ["M9.5 4L7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16"] },
    chevron: { d: ["M7 10l5 5 5-5"] },
    back: { d: ["M19 12H5M11 6l-6 6 6 6"] },
    attach: {
      d: [
        "M15.5 7.5l-6.8 6.8a2 2 0 0 0 2.8 2.8l7-7a4 4 0 0 0-5.6-5.6l-7 7a6 6 0 0 0 8.5 8.5l6.3-6.3",
      ],
    },
    file: { d: ["M7 3.5h7l4.5 4.5v12.5H7z", "M14 3.5V8h4.5"] },
    inbox: { d: ["M4 13l2.5-7.5h11L20 13v6H4z", "M4 13h4.5l1 2h5l1-2H20"] },
    refresh: { d: ["M19.5 12a7.5 7.5 0 1 1-2.2-5.3", "M19.5 4.5v4h-4"] },
  }
</script>

<script lang="ts">
  let { name, size = 22 }: { name: string; size?: number } = $props()
  const icon = $derived(ICONS[name] ?? ICONS.x!)
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  aria-hidden="true"
  fill={icon.fill ? "currentColor" : "none"}
  stroke={icon.fill ? "none" : "currentColor"}
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  {#each icon.d as d (d)}<path {d} />{/each}
</svg>
