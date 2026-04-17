// Vendored picocolors v1.1.1 — zero-dependency ANSI color library.
// Ported to TypeScript ESM. Original: https://github.com/alexeyraspopov/picocolors
// Only the subset of colors we actually use is exported to keep this minimal.

type Formatter = (input: string | number | null | undefined) => string

const p = process || ({} as NodeJS.Process)
const argv = p.argv || []
const env = p.env || {}

const isColorSupported =
  !(!!env.NO_COLOR || argv.includes('--no-color')) &&
  (!!env.FORCE_COLOR ||
    argv.includes('--color') ||
    p.platform === 'win32' ||
    ((p.stdout || ({} as NodeJS.WriteStream)).isTTY && env.TERM !== 'dumb') ||
    !!env.CI)

function replaceClose(string: string, close: string, replace: string, index: number): string {
  let result = ''
  let cursor = 0
  let i = index
  do {
    result += string.substring(cursor, i) + replace
    cursor = i + close.length
    i = string.indexOf(close, cursor)
  } while (~i)
  return result + string.substring(cursor)
}

function formatter(open: string, close: string, replace = open): Formatter {
  if (!isColorSupported) return String
  return (input) => {
    const string = '' + input
    const index = string.indexOf(close, open.length)
    return ~index ? open + replaceClose(string, close, replace, index) + close : open + string + close
  }
}

export const bold = formatter('\x1b[1m', '\x1b[22m', '\x1b[22m\x1b[1m')
export const dim = formatter('\x1b[2m', '\x1b[22m', '\x1b[22m\x1b[2m')
export const yellow = formatter('\x1b[33m', '\x1b[39m')
export const blue = formatter('\x1b[34m', '\x1b[39m')
export const cyan = formatter('\x1b[36m', '\x1b[39m')
export const white = formatter('\x1b[37m', '\x1b[39m')
export const gray = formatter('\x1b[90m', '\x1b[39m')
export const green = formatter('\x1b[32m', '\x1b[39m')
export const red = formatter('\x1b[31m', '\x1b[39m')
export const magenta = formatter('\x1b[35m', '\x1b[39m')
