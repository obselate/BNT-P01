export const CHAIN_BASE_URL = "."

import { ristretto255, sha3_256, bytesToHex, concatBytes, hexToBytes } from "./vendor/noble.js"

const text = new TextEncoder()
const scalarOrder = 2n ** 252n + 27742317777372353535851937790883648493n
const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
const integer = bytes => bytes.reduceRight((value, byte) => value * 256n + BigInt(byte), 0n)
const equal = (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index])

function le32(value) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

function scalarBytes(value) {
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number(value & 255n)
    value >>= 8n
  }
  return bytes
}

async function readTransaction(hash) {
  const name = bytesToHex(await sha256(hexToBytes(hash)))
  const response = await fetch(`${CHAIN_BASE_URL}/tx/${name}`, { credentials: "omit", referrerPolicy: "no-referrer" })
  if (!response.ok) throw new Error(response.status === 404 ? "Not found" : "Fetch failed")
  const { publicKey, memos } = await response.json()
  return { publicKey: hexToBytes(publicKey), outputs: memos.map(([index, memo]) => ({ index, encrypted: hexToBytes(memo) })) }
}

function decryptMemo(encrypted, secret, index) {
  const seed = sha3_256(concatBytes(secret, text.encode("memo"), le32(index), text.encode("blocknet_mainnet")))
  const plain = new Uint8Array(128)
  for (let block = 0; block < 4; block++) {
    const mask = sha3_256(concatBytes(seed, le32(block)))
    for (let offset = 0; offset < 32; offset++) plain[block * 32 + offset] = encrypted[block * 32 + offset] ^ mask[offset]
  }
  const length = plain[1]
  if (plain[0] !== 1 || length > 124) return null
  const payload = plain.slice(4, 4 + length)
  const checksum = sha3_256(concatBytes(text.encode("blocknet_memo_checksum"), Uint8Array.of(length, 0), payload))
  return plain[2] === checksum[0] && plain[3] === checksum[1] ? payload : null
}

async function decodeCart(memos) {
  const header = memos.find(memo => memo.length >= 40 && memo.length <= 124 && memo[0] === 72 && memo[1] === 1)
  if (!header) throw new Error("Not found")
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const length = view.getUint32(34)
  const count = view.getUint16(38)
  if (!length || length > 66000 || count !== Math.ceil(length / 113)) throw new Error("Invalid cart")
  const chunks = new Map()
  for (const memo of memos) {
    if (memo.length < 11 || memo.length > 124 || memo[0] !== 67 || !equal(memo.subarray(1, 9), header.subarray(2, 10))) continue
    const index = memo[9] * 256 + memo[10]
    if (chunks.has(index) && !equal(chunks.get(index), memo)) throw new Error("Invalid cart")
    chunks.set(index, memo)
  }
  if (chunks.size !== count) throw new Error("Incomplete cart")
  const compressed = new Uint8Array(length)
  for (let index = 0; index < count; index++) {
    const chunk = chunks.get(index)
    const size = Math.min(113, length - index * 113)
    if (!chunk || chunk.length !== size + 11) throw new Error("Incomplete cart")
    compressed.set(chunk.subarray(11), index * 113)
  }
  if (!equal(await sha256(compressed), header.subarray(2, 34))) throw new Error("Hash mismatch")
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")).getReader()
  const buffer = new Uint8Array(65536)
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.length > buffer.length) throw new Error("Invalid cart")
      buffer.set(value, size)
      size += value.length
    }
  } finally {
    await reader.cancel()
  }
  const wasm = buffer.slice(0, size)
  if (size < 8 || !equal(wasm.subarray(0, 4), Uint8Array.of(0, 97, 115, 109))) throw new Error("Invalid cart")
  console.log("WASM SHA-256", bytesToHex(await sha256(wasm)))
  return wasm
}

export async function loadCartridge(hash, key) {
  if (!/^[a-f0-9]{64}$/i.test(hash ?? "")) throw new Error("Invalid transaction")
  if (!/^[a-f0-9]{64}$/i.test(key ?? "")) throw new Error("Invalid key")
  const scalar = integer(hexToBytes(key))
  if (scalar === 0n || scalar >= scalarOrder) throw new Error("Invalid key")
  const transaction = await readTransaction(hash.toLowerCase())
  const shared = ristretto255.Point.fromBytes(transaction.publicKey).multiply(scalar).toBytes()
  const memos = []
  for (const { index, encrypted } of transaction.outputs) {
    if (!encrypted) continue
    for (const indexed of [true, false]) {
      const input = concatBytes(text.encode("blocknet_stealth_hs"), shared, indexed ? le32(index) : new Uint8Array())
      const secret = scalarBytes(integer(await sha256(input)) % scalarOrder)
      const payload = decryptMemo(encrypted, secret, index)
      if (payload) {
        memos.push(payload)
        break
      }
    }
  }
  if (!memos.length) throw new Error("Wrong key")
  return decodeCart(memos)
}
