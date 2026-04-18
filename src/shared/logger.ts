const prefix = '[cf-sync-kit]'

export const isDev = (typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV === true) ||
  (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development')

export const log = {
  success: (msg: string, ...args: unknown[]) => {
    console.log(`${prefix} ✓ ${msg}`, ...args)
  },
  error: (msg: string, ...args: unknown[]) => {
    console.error(`${prefix} ✗ ${msg}`, ...args)
  },
  warn: (msg: string, ...args: unknown[]) => {
    console.warn(`${prefix} ⚠ ${msg}`, ...args)
  },
  info: (msg: string, ...args: unknown[]) => {
    console.log(`${prefix} ℹ ${msg}`, ...args)
  },
  debug: (msg: string, ...args: unknown[]) => {
    if (isDev) console.log(`${prefix} ${msg}`, ...args)
  },
}
