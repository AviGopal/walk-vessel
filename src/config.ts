// SPDX-License-Identifier: MIT
const need = (v: string | undefined): string => {
  if (v === undefined) {
    process.exit(1)
  }
  return v
}
export const VESSEL_ID = need(process.env.WALK_VESSEL_ID)
export const PORT = Number(need(process.env.WALK_PORT))
export const DISCOVERY_URL = need(process.env.DISCOVERY_URL)
export const KEY_PATH = need(process.env.WALK_KEY_PATH)
export const ENDPOINT = need(process.env.WALK_ENDPOINT)
export const KEY = (await Bun.file(KEY_PATH).text()).trim()
