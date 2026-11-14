import { describe, expect, it } from "vitest"
import { linkify } from "../src/lib/linkify.ts"

describe("linkify", () => {
  it("links http(s) URLs and trims trailing punctuation", () => {
    expect(linkify("see https://example.com/a. ok")).toEqual([
      { text: "see " },
      { text: "https://example.com/a", href: "https://example.com/a" },
      { text: ". ok" },
    ])
  })
  it("keeps balanced parentheses and drops unbalanced ones", () => {
    expect(linkify("(https://en.wikipedia.org/wiki/A_(b))")[1]!.href).toBe(
      "https://en.wikipedia.org/wiki/A_(b)",
    )
    expect(linkify("(see https://x.example/y)")[1]!.href).toBe("https://x.example/y")
  })
  it("never links other schemes", () => {
    expect(linkify("javascript:alert(1) data:text/html,x ftp://x")).toEqual([
      { text: "javascript:alert(1) data:text/html,x ftp://x" },
    ])
  })
})
