// ESM wrapper over the CommonJS core. Importing the core rather than
// reimplementing it means one module instance, one native binding load, and one
// return slot per realm -- no dual-package hazard.
import nanoepoch from './index.js'

export const now = nanoepoch.now
export const nowMicros = nanoepoch.nowMicros
export const nowInto = nanoepoch.nowInto
