export function readStorage(key, fallback = null) {
  try {
    const value = window.localStorage.getItem(key)
    return value == null ? fallback : value
  } catch {
    return fallback
  }
}

export function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function readJsonStorage(key, fallback) {
  const raw = readStorage(key, null)
  if (!raw) return fallback

  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function writeJsonStorage(key, value) {
  return writeStorage(key, JSON.stringify(value))
}
