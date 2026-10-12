# Intent

This repository exists so that a TaskFast user can have their own agent working on the marketplace quickly. They might type the commands themselves, or ask a coding agent such as Claude Code, OpenAI Codex, pi or GitHub Copilot to do it for them. Both paths should be short, and both should be safe.

When a change is unclear, choose the option that keeps those two things true.

## Who it is for

A TaskFast user who wants an agent to post jobs, take jobs, or both, using their own account, wallet and model key. They may not write code. If they do, they may want to change how the agent decides, not just what it is called.

## What "fast" means

From an empty folder to a working agent:

```bash
git clone https://github.com/Akuja-Inc/taskfast-agent-starter && cd taskfast-agent-starter
pnpm install
pnpm setup-agent --env staging    # provider, key, model, who the agent is, taskfast init
pnpm dev                          # in one terminal
pnpm agents --env staging         # in another
```

Every step a person has to take beyond those is a cost. A change that adds a step, a prompt, a config file or a manual edit has to earn it.

## Two ways to run it, one design

- **A person at a terminal.** `pnpm setup-agent` asks one question at a time and suggests an answer for each one it can.
- **A coding agent.** It reads `AGENTS.md`, `CONTEXT.md` and this file. Then it runs the same commands without prompts: every setup question has a flag, and setup checks every flag before it changes anything.

Neither path depends on the other. Keep them equal: a new question in setup gets a flag in the same change, and anything a coding agent needs to know goes in these files, not in one tool's own settings.

## Principles

These are decisions already made. Change one only on purpose, and say so.

- **The user holds everything.** Their TaskFast account, wallet, API key and model key stay on their machine. Nothing in this repository holds money or keys for them.
- **Code sets the money, not the model.** The model chooses what to do. Prices and fees come from the server, the agent's limits are checked in code, and each write runs at most once.
- **Honest agents only.** Every agent here acts as an ordinary marketplace user would. `test/kit.test.ts` keeps private TaskFast test tooling out of the repository; keeping the agent honest is up to each change.
- **Any model the user already pays for.** Every AI SDK provider that can call tools, plus OpenRouter and Ollama. Suggested models are generated from current data, never hand-picked, so they do not go stale.
- **Production works the same as the `taskfast` CLI.** Production is the default because that is where users' agents live. Staging and development are one flag away.
- **This repository is where the agent is developed.** TaskFast's own persona tooling pins it by commit. A change here reaches TaskFast only through a TaskFast PR that bumps the pin.

## Not in scope

- Adversarial, deceptive or test-population agents.
- Hosting or custody: no service that runs agents or holds funds for users.
- A general agent framework. The agent does TaskFast marketplace work.
- Instructions for one coding tool only. Guidance goes in the shared files.
