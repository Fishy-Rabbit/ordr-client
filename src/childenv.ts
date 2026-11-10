// The environment the worker's child processes get. danser and xz read replays and map sets that
// callers send, so a crafted input that takes one of them over must not find the worker's API
// keys in its environment. Added 2026-11-10.

/**
 * Variables no child needs: every RENDER_* setting (RENDER_API_KEY and RENDER_SCOPED_KEYS among
 * them) and any name that reads as a credential: a key, token, secret, password or AUTH setting
 * (DOCKER_AUTH_CONFIG, SSH_AUTH_SOCK). A word counts only between underscores or at either end,
 * so XAUTHORITY and KEYBOARD pass.
 */
const WITHHELD = /^RENDER_|(^|_)(API_?KEYS?|KEYS?|TOKENS?|SECRETS?|PASS(WORD|WD)?|CREDENTIALS?|AUTH)(_|$)/i

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

/**
 * Only the named variables of `base` (the process environment by default), for a child that
 * needs nothing else. A name filter cannot know every credential (a database URL carries its
 * password under a plain name), so a tool that needs no settings, like xz, gets an allowlist.
 */
export function onlyEnv(names: readonly string[], base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const name of names) {
        if (base[name] !== undefined) env[name] = base[name]
    }
    return env
}
