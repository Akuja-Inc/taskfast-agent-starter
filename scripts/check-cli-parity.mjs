#!/usr/bin/env node
// Fails when the agent's tools and the captured taskfast CLI surface disagree (see
// src/core/cli-parity.ts). Offline: it reads test/fixtures/cli/surface.json and the built
// TOOLS table in dist/, so run it after a build (`pnpm test` builds first).
import { readFileSync } from "node:fs";
import { parityProblems, parseSurface } from "../dist/src/core/cli-parity.js";
import { TOOLS } from "../dist/src/core/tools.js";

const { version, help } = JSON.parse(readFileSync(new URL("../test/fixtures/cli/surface.json", import.meta.url), "utf8"));
const problems = parityProblems(TOOLS, parseSurface(help));
for (const problem of problems) console.error(problem);
if (problems.length) process.exit(1);
console.log(`tools match ${version}`);
