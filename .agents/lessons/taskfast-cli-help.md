# Reading the TaskFast CLI's help

- `taskfast <command> -h` drops the `[possible values: ...]` of an option whose values appear only in its long help (`discover --status` looks free text), and help prints the value of every env var an option reads; capture with `--help` under only PATH, an empty HOME and an absent config, as `scripts/capture-cli-surface.mjs` does. (taskfast-cli 0.19.8, issue #91)
