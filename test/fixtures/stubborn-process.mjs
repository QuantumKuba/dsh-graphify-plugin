import fs from 'node:fs'

const pidFile = process.env.PID_FILE
if (pidFile) {
  fs.writeFileSync(pidFile, String(process.pid))
}

// Ignore SIGTERM to force escalation to SIGKILL
process.on('SIGTERM', () => {
  // Ignored on purpose
})

setInterval(() => {}, 1000)
