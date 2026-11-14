import { describe, expect, it } from "vitest"
import { Jwt } from "hono/utils/jwt"
import { userFromAccessToken } from "../src/auth.ts"
import type { Env } from "../src/env.ts"

const TEAM = "https://synthetic-team.cloudflareaccess.com"
const AUD = "synthetic-aud"

async function keyPair() {
  const kp = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey
  const priv = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey
  const kid = crypto.randomUUID()
  // Signing with a JWK that carries a kid puts the kid in the token header.
  return {
    privateKey: { ...priv, kid, alg: "RS256" },
    jwk: { ...pub, kid, alg: "RS256", use: "sig" },
  }
}

const env = {
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  OWNER_EMAIL: "owner@example.com",
  SERVICE_TOKEN_CLIENT_ID: "synthetic-client.access",
} as Env

describe("Access JWT", async () => {
  const { privateKey, jwk } = await keyPair()
  const other = await keyPair()
  const keys = async () => [jwk] as never
  const now = Math.floor(Date.now() / 1000)
  const sign = (claims: Record<string, unknown>, key: JsonWebKey = privateKey) =>
    Jwt.sign({ iss: TEAM, aud: AUD, iat: now, exp: now + 300, ...claims }, key as never, "RS256")

  it("maps the owner's email and the CLI service token to the owner", async () => {
    expect(await userFromAccessToken(await sign({ email: "Owner@Example.com" }), env, keys)).toBe(
      "u_owner",
    )
    expect(
      await userFromAccessToken(await sign({ common_name: "synthetic-client.access" }), env, keys),
    ).toBe("u_owner")
  })

  it("rejects other identities, wrong audience, wrong issuer, wrong key and expired tokens", async () => {
    expect(
      await userFromAccessToken(await sign({ email: "someone@example.com" }), env, keys),
    ).toBeNull()
    expect(
      await userFromAccessToken(
        await sign({ email: "owner@example.com", aud: "other" }),
        env,
        keys,
      ),
    ).toBeNull()
    expect(
      await userFromAccessToken(
        await sign({ email: "owner@example.com", iss: "https://evil.example" }),
        env,
        keys,
      ),
    ).toBeNull()
    // Signed by a different key that claims the trusted kid.
    const forged = { ...other.privateKey, kid: jwk.kid }
    expect(
      await userFromAccessToken(await sign({ email: "owner@example.com" }, forged), env, keys),
    ).toBeNull()
    expect(
      await userFromAccessToken(
        await sign({ email: "owner@example.com", exp: now - 10 }),
        env,
        keys,
      ),
    ).toBeNull()
  })

  it("fails closed when Access is not configured", async () => {
    const token = await sign({ email: "owner@example.com" })
    expect(await userFromAccessToken(token, { ...env, ACCESS_AUD: "" }, keys)).toBeNull()
    expect(
      await userFromAccessToken(
        token,
        { ...env, OWNER_EMAIL: "", SERVICE_TOKEN_CLIENT_ID: "" },
        keys,
      ),
    ).toBeNull()
  })
})
