// The environment the worker's child processes get. danser and xz read replays and map sets that
// callers send, so a crafted input that takes one of them over must not find the worker's API
// keys in its environment. Added 2026-11-10.

/**
 * Variables no child needs, case ignored:
 * - every RENDER_* setting (RENDER_API_KEY and RENDER_SCOPED_KEYS among them);
 * - any name that contains SECRET, TOKEN, PASSWORD, PASSWD or CREDENTIAL anywhere, joined to other
 *   words or not (CLIENTSECRET, DB_PASSWORD, GOOGLE_APPLICATION_CREDENTIALS);
 * - any name with KEY, APIKEY (or API_KEY), a plural of those, PASS, AUTH or AUTHORIZATION as a
 *   whole word: between underscores or at either end (DOCKER_AUTH_CONFIG, SSH_AUTH_SOCK, SMTP_PASS).
 * The short words count only as whole words, so XAUTHORITY, KEYBOARD and PASSAGE pass; a name such
 * as DBPASS passes too, which is why the README tells operators to keep credentials out of the
 * worker's environment instead of relying on this list.
 */
const WITHHELD = /^RENDER_|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|(^|_)(API_?KEYS?|KEYS?|PASS|AUTH|AUTHORIZATION)(_|$)/i

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
