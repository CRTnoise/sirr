# Contributing

Thank you for helping. A few things matter more here than in most projects, because people may rely on this software when it is dangerous for them to be overheard.

## Ground rules

- **No telemetry, no third-party requests.** Nothing may contact a server outside the swarm unless the user turned it on and the setting says exactly what it reveals.
- **Say what it doesn't protect.** UI copy and docs never claim more than the code does. If a feature has a privacy cost, the setting explains it.
- **Wire and at-rest changes need a test** in `test/` and an update to `docs/PROTOCOL.md`.
- **Pin dependencies.** Exact versions in `package.json`, lockfile committed. New dependencies need a reason.

## Before a pull request

```sh
npm ci
npm run test:all
npm run preview      # if you touched the UI: look at dev/shot-*.png
```

Keep commits focused, and describe *why* in the message. Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Style

Plain JavaScript (CommonJS in `lib/`, ES modules in `renderer/`), no build step for the app. Comments explain why, in the present tense. UI follows the instrument rules at the end of `renderer/style.css`: one signal colour, the stroke is the highlight, nothing pulses forever.
