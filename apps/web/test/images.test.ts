import { describe, expect, it } from "vitest"
import { gifSize, prepareFile } from "../src/lib/images.ts"

// Synthetic bytes only.
function gif(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(32)
  b.set(new TextEncoder().encode("GIF89a"))
  new DataView(b.buffer).setUint16(6, width, true)
  new DataView(b.buffer).setUint16(8, height, true)
  return b
}

describe("prepareFile (ADR-0017)", () => {
  it("keeps GIFs byte for byte and reads their size from the header", async () => {
    const bytes = gif(320, 180)
    const p = await prepareFile(new File([bytes], "synthetic.gif", { type: "image/gif" }))
    expect(p.data).toEqual(bytes)
    expect(p).toMatchObject({ mime: "image/gif", name: "synthetic.gif", width: 320, height: 180 })
    expect(gifSize(new TextEncoder().encode("not a gif at all"))).toBeUndefined()
  })

  it("keeps any other file as it is, with its name and type", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(1000))
    const zip = await prepareFile(new File([bytes], "synthetic.zip", { type: "application/zip" }))
    expect(zip).toEqual({ data: bytes, mime: "application/zip", name: "synthetic.zip" })
    const unknown = await prepareFile(new File([bytes], "blob.bin"))
    expect(unknown.mime).toBe("application/octet-stream")
  })
})
