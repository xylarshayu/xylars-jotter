/**
 * Holds decrypted channel identities in memory only.
 *
 * - Open channels: unwrapped with the account open key.
 * - Locked channels: unwrapped with a passphrase that is used once and dropped.
 *
 * Fail closed: a channel is only ever treated as open if the server says
 * "open" AND its wrapped key is not passphrase-wrapped AND the open key can
 * unwrap it. Nothing here is persisted.
 */
import {
  type AgeIdentity,
  type AgeRecipient,
  fromBase64,
  isPassphraseWrapped,
  recipientOf,
  unwrapWithIdentity,
  unwrapWithPassphrase,
} from "@jot/crypto"
import type { ChannelRow } from "./model.ts"

export class LockedError extends Error {
  override name = "LockedError"
  constructor(message = "channel is locked") {
    super(message)
  }
}

/** True only for channels that are safely readable with the open key. */
export function isOpenChannel(row: Pick<ChannelRow, "lock" | "wrappedKey">): boolean {
  if (row.lock !== "open") return false
  try {
    return !isPassphraseWrapped(fromBase64(row.wrappedKey))
  } catch {
    return false
  }
}

export class KeyRing {
  #openIdentity: AgeIdentity | undefined
  #openRecipient: AgeRecipient | undefined
  #open = new Map<string, AgeIdentity>()
  #unlocked = new Map<string, AgeIdentity>()
  #listeners = new Set<(channelId: string | null) => void>()

  async setOpenKey(identity: AgeIdentity | undefined): Promise<void> {
    this.#open.clear()
    this.#openIdentity = identity?.trim()
    this.#openRecipient = this.#openIdentity ? await recipientOf(this.#openIdentity) : undefined
  }

  get hasOpenKey(): boolean {
    return this.#openIdentity !== undefined
  }

  get openRecipient(): AgeRecipient | undefined {
    return this.#openRecipient
  }

  /** The account open key, for reading what is sealed to it directly (channel names). */
  get openIdentity(): AgeIdentity | undefined {
    return this.#openIdentity
  }

  /** Returns the channel identity if it is available without a passphrase prompt. */
  async identityFor(row: ChannelRow): Promise<AgeIdentity | undefined> {
    const unlocked = this.#unlocked.get(row.id)
    if (unlocked) return unlocked
    if (!isOpenChannel(row) || !this.#openIdentity) return undefined
    const cached = this.#open.get(row.id)
    if (cached) return cached
    try {
      const identity = await unwrapWithIdentity(fromBase64(row.wrappedKey), this.#openIdentity)
      if ((await recipientOf(identity)) !== row.recipient) return undefined
      this.#open.set(row.id, identity)
      return identity
    } catch {
      return undefined
    }
  }

  /** Unlocks a locked channel for this session. Throws CryptoError on a wrong passphrase. */
  async unlock(row: ChannelRow, passphrase: string): Promise<void> {
    const identity = await unwrapWithPassphrase(fromBase64(row.wrappedKey), passphrase)
    if ((await recipientOf(identity)) !== row.recipient)
      throw new LockedError("key does not match channel")
    this.#unlocked.set(row.id, identity)
    this.#emit(row.id)
  }

  isUnlocked(channelId: string): boolean {
    return this.#unlocked.has(channelId)
  }

  unlockedIds(): string[] {
    return [...this.#unlocked.keys()]
  }

  lock(channelId: string): void {
    if (this.#unlocked.delete(channelId)) this.#emit(channelId)
  }

  lockAll(): void {
    if (this.#unlocked.size === 0) return
    this.#unlocked.clear()
    this.#emit(null)
  }

  /** Forget everything, including the open key. */
  clear(): void {
    this.#open.clear()
    this.#unlocked.clear()
    this.#openIdentity = undefined
    this.#openRecipient = undefined
    this.#emit(null)
  }

  /** Called with the channel id that was locked/unlocked, or null for "all". */
  onChange(fn: (channelId: string | null) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  #emit(channelId: string | null): void {
    for (const fn of this.#listeners) fn(channelId)
  }
}
