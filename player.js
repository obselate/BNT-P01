import { loadCartridge } from "./cartridge.js"

const form = document.querySelector("form")
const status = document.querySelector("#status")
const button = form.querySelector("button")
const messages = new Set(["Not found", "Wrong key", "Fetch failed", "Invalid transaction", "Invalid key", "Invalid cart", "Incomplete cart", "Hash mismatch"])

function encodeCart(bytes) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#"
  let encoded = ""
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let value = 0
    for (let index = 0; index < 4; index++) value = value * 256 + (bytes[offset + index] ?? 0)
    for (let divisor = 85 ** 4; divisor >= 1; divisor /= 85) encoded += alphabet[Math.floor(value / divisor) % 85]
  }
  return encoded
}

form.addEventListener("submit", async event => {
  event.preventDefault()
  button.disabled = true
  status.textContent = "Loading"
  try {
    const hash = document.querySelector("#transaction").value.replace(/\s/g, "")
    const key = document.querySelector("#key")
    const wasm = await loadCartridge(hash, key.value.replace(/\s/g, ""))
    await WebAssembly.compile(wasm)
    await customElements.whenDefined("wasm4-app")
    const cartridge = document.createElement("script")
    cartridge.id = "wasm4-cart-json"
    cartridge.type = "application/json"
    cartridge.textContent = JSON.stringify({ WASM4_CART: encodeCart(wasm), WASM4_CART_SIZE: wasm.length })
    const disk = document.createElement("script")
    disk.id = "wasm4-disk-prefix"
    disk.type = "text/plain"
    disk.textContent = `blocknet-${hash.toLowerCase()}`
    document.body.append(cartridge, disk)
    key.value = ""
    document.querySelector("#lock").remove()
    document.body.append(document.createElement("wasm4-app"))
  } catch (error) {
    status.textContent = messages.has(error.message) ? error.message : "Load failed"
    button.disabled = false
  }
})
