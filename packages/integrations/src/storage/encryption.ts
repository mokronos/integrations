import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto"
import { Encoding } from "effect"
import { concatBytes, decodeBase64Field, utf8Text } from "@integrations/contracts"

const envelopePrefix = "enc.v1$"

export interface Encryption {
  readonly seal: (text: string) => string
  readonly open: (text: string) => string
  readonly lookup: (text: string) => string
}

const sealWith = (masterKey: Uint8Array) => (text: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv)
  const ciphertext = concatBytes([cipher.update(text, "utf8"), cipher.final()])
  return `${envelopePrefix}${Encoding.encodeBase64(iv)}$${Encoding.encodeBase64(cipher.getAuthTag())}$${Encoding.encodeBase64(ciphertext)}`
}

const openWith = (masterKey: Uint8Array) => (text: string): string => {
  if (!text.startsWith(envelopePrefix)) return text
  const [ivText, tagText, dataText] = text.slice(envelopePrefix.length).split("$")
  if (ivText === undefined || tagText === undefined || dataText === undefined) {
    throw new Error("Malformed encrypted value")
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey,
    decodeBase64Field("initialisation vector", ivText)
  )
  decipher.setAuthTag(decodeBase64Field("authentication tag", tagText))
  return utf8Text(concatBytes([
    decipher.update(decodeBase64Field("ciphertext", dataText)),
    decipher.final()
  ]))
}

const lookupWith = (masterKey: Uint8Array) => (text: string): string =>
  createHmac("sha256", masterKey).update(text).digest("hex")

export const createEncryption = (masterKey: Uint8Array): Encryption => ({
  seal: sealWith(masterKey),
  open: openWith(masterKey),
  lookup: lookupWith(masterKey)
})
