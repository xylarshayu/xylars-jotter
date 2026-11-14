// Renders the PNG app icons (no image dependencies): node scripts/icons.mjs
import { writeFileSync } from "node:fs"
import { deflateSync } from "node:zlib"

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}

// Signed distance to a rounded rectangle centred at (cx, cy).
const rrect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r
  const qy = Math.abs(y - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const cov = (d) => Math.min(1, Math.max(0, 0.5 - d))

function icon(size, { maskable }) {
  const s = size / 512
  const bg = [0x2b, 0x59, 0xc3]
  const bars = [
    [128, 150, 256, 1],
    [128, 236, 200, 0.85],
    [128, 322, 140, 0.7],
  ]
  // Maskable icons need content inside the central 80% safe zone.
  const k = maskable ? 0.8 : 1
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const a = maskable ? 1 : cov(rrect(px, py, 256 * s, 256 * s, 256 * s, 256 * s, 112 * s))
      let [r, g, b] = bg
      for (const [bx, by, bw, op] of bars) {
        const cx = 256 + (bx + bw / 2 - 256) * k
        const cy = 256 + (by + 20 - 256) * k
        const w = cov(rrect(px, py, cx * s, cy * s, (bw / 2) * k * s, 20 * k * s, 20 * k * s)) * op
        r += (255 - r) * w
        g += (255 - g) * w
        b += (255 - b) * w
      }
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = Math.round(a * 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const out = new URL("../public/", import.meta.url)
writeFileSync(new URL("icon-180.png", out), icon(180, { maskable: true }))
writeFileSync(new URL("icon-192.png", out), icon(192, { maskable: false }))
writeFileSync(new URL("icon-512.png", out), icon(512, { maskable: false }))
writeFileSync(new URL("icon-maskable-512.png", out), icon(512, { maskable: true }))
