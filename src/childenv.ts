// The environment the worker's child processes get. danser and xz read replays and map sets that
// callers send, so a crafted input that takes one of them over must not find the worker's API
// keys in its environment. Added 2026-11-10.

/**
 * Variables no child needs: every RENDER_* setting (RENDER_API_KEY and RENDER_SCOPED_KEYS among
 * them) and any name that reads as a credential (a key, token, secret or password).
 */
const WITHHELD = /^RENDER_|(^|_)(API_?KEYS?|KEYS?|TOKENS?|SECRETS?|PASS(WORD|WD)?|CREDENTIALS?)(_|$)/i

/**
 * A copy of `base` (the process environment by default) without what only the worker may hold
 * (see WITHHELD). Everything else passes through (PATH, HOME, locale, library paths), so a child
 * starts as it did when it inherited the whole environment.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(base)) {
        if (!WITHHELD.test(name)) env[name] = value
    }
    return env
}
