import fs from "fs"
import path from "path"
import injectTimestamp from "./util/inject_timestamp"
import { loadConfig, VERSION } from "./config"
import { Journal } from "./journal"
import { Xvfb } from "./xvfb"
import { generateSettingsTemplate, prepareSlotDirs, SlotPaths } from "./job"
import { Json } from "./renderers/danser/prepare"
import { Scheduler } from "./queue"
import { createServer } from "./server"

injectTimestamp()
const log = (line: string) => console.log(line)

async function main(): Promise<void> {
    const cfg = loadConfig()
    log(`ordr-render ${VERSION} starting (${cfg.fake ? "FAKE mode" : `danser ${cfg.danserVersion}, ${cfg.concurrency} slot(s) x ${cfg.threadsPerSlot} threads`})`)
    for (const dir of [cfg.videosDir, cfg.songsDir, cfg.skinsDir, cfg.stateDir, cfg.replaysDir, cfg.workDir]) fs.mkdirSync(dir, { recursive: true })

    const journal = new Journal(cfg.stateDir)
    journal.load()
    log(`journal: ${journal.all().length} render(s) on record`)

    const displays: Xvfb[] = []
    const slots: SlotPaths[] = []
    let template: Json = {}
    if (!cfg.fake) {
        if (!fs.existsSync(path.join(cfg.danserDir, "danser-cli"))) throw new Error(`danser-cli not found in ${cfg.danserDir} (DANSER_DIR)`)
        for (let i = 0; i < cfg.concurrency; i++) {
            const xvfb = new Xvfb(cfg.displayBase + i, log)
            await xvfb.start()
            displays.push(xvfb)
            slots.push(prepareSlotDirs(cfg, i, xvfb.displayName))
            log(`slot ${i}: display ${xvfb.displayName}, work dir ${slots[i].root}`)
        }
        template = await generateSettingsTemplate(cfg, slots[0], log)
    }

    const scheduler = new Scheduler(cfg, journal, slots, template, log)
    scheduler.start()

    const server = createServer(cfg, journal, scheduler, log)
    server.listen(cfg.port, "0.0.0.0", () => log(`listening on :${cfg.port}`))

    let shuttingDown = false
    const shutdown = (signal: string) => {
        if (shuttingDown) return
        shuttingDown = true
        log(`${signal}: shutting down`)
        server.close()
        scheduler.stop()
        for (const d of displays) d.stop()
        setTimeout(() => {
            journal.flush()
            process.exit(0)
        }, 1500)
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"))
    process.on("SIGINT", () => shutdown("SIGINT"))
}

process.on("unhandledRejection", err => {
    console.error("fatal: unhandled rejection", err)
    process.exit(1)
})

main().catch(err => {
    console.error(`fatal: ${(err as Error).message}`)
    process.exit(1)
})
