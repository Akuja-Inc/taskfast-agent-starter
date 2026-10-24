import { describe, expect, it } from "vitest";
import { parseSecrets } from "./secrets.js";

const config = JSON.stringify({ environment: "staging", api_key: "k", keystore_path: ".taskfast/wallet.json" });
const keystore = JSON.stringify({ version: 3, crypto: {} });

describe("parseSecrets", () => {
  it("reads the config alone, with no wallet", () => {
    expect(parseSecrets({ TASKFAST_CONFIG: config })).toEqual({ config, settings: {} });
  });
  it("reads model settings and the wallet", () => {
    expect(parseSecrets({ TASKFAST_CONFIG: config, MODEL_SETTINGS: '{"ANTHROPIC_API_KEY":"x"}', WALLET_KEYSTORE: keystore, WALLET_PASSWORD: "correct horse battery" }))
      .toEqual({ config, settings: { ANTHROPIC_API_KEY: "x" }, wallet: { keystore, password: "correct horse battery" } });
  });
  it.each([
    ["no config", {}, "the TASKFAST_CONFIG secret is missing"],
    ["a config that is not JSON", { TASKFAST_CONFIG: "{" }, "the TASKFAST_CONFIG secret is not JSON"],
    ["a config that is an array", { TASKFAST_CONFIG: "[]" }, "the TASKFAST_CONFIG secret is not a JSON object"],
    ["settings that are not strings", { TASKFAST_CONFIG: config, MODEL_SETTINGS: '{"A":1}' }, "the MODEL_SETTINGS secret must map names to strings"],
    ["a keystore without a password", { TASKFAST_CONFIG: config, WALLET_KEYSTORE: keystore }, "set both WALLET_KEYSTORE and WALLET_PASSWORD, or neither"],
    ["a password without a keystore", { TASKFAST_CONFIG: config, WALLET_PASSWORD: "pw" }, "set both WALLET_KEYSTORE and WALLET_PASSWORD, or neither"],
    ["a keystore that is not JSON", { TASKFAST_CONFIG: config, WALLET_KEYSTORE: "nope", WALLET_PASSWORD: "pw" }, "the WALLET_KEYSTORE secret is not JSON"],
    ["a password on two lines", { TASKFAST_CONFIG: config, WALLET_KEYSTORE: keystore, WALLET_PASSWORD: "a\nb" }, "the WALLET_PASSWORD secret must be one line"],
    ["a config with an absolute keystore path", { TASKFAST_CONFIG: JSON.stringify({ keystore_path: "/home/me/wallet.json" }), WALLET_KEYSTORE: keystore, WALLET_PASSWORD: "pw" }, 'TASKFAST_CONFIG must have keystore_path ".taskfast/wallet.json" to sign'],
  ])("refuses %s", (_name, env, reason) => {
    expect(() => parseSecrets(env)).toThrow(reason);
  });
});
