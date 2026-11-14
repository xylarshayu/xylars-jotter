const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** ULID: 48-bit ms timestamp + 80 random bits, Crockford base32. */
export function newId(now: number = Date.now()): string {
  let time = ""
  let t = now
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time
    t = Math.floor(t / 32)
  }
  const rnd = crypto.getRandomValues(new Uint8Array(16))
  let rand = ""
  for (let i = 0; i < 16; i++) rand += ALPHABET[rnd[i]! % 32]
  return time + rand
}
