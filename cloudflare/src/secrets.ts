// The deployment's secrets, checked before the agent opens so a missing or malformed
// one shows as a stopped agent with its reason. Never logged or shown.
import type { Wallet } from "./container.js";

export interface SecretEnv {
  TASKFAST_CONFIG?: string;
  MODEL_SETTINGS?: string;
  WALLET_KEYSTORE?: string;
  WALLET_PASSWORD?: string;
}
export interface Secrets { config: string; settings: Record<string, string>; wallet?: Wallet }

const object = (text: string, name: string): Record<string, unknown> => {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`the ${name} secret is not JSON`); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`the ${name} secret is not a JSON object`);
  return value as Record<string, unknown>;
};

export function parseSecrets(env: SecretEnv): Secrets {
  if (!env.TASKFAST_CONFIG) throw new Error("the TASKFAST_CONFIG secret is missing");
  const config = object(env.TASKFAST_CONFIG, "TASKFAST_CONFIG");
  const settings = env.MODEL_SETTINGS ? object(env.MODEL_SETTINGS, "MODEL_SETTINGS") : {};
  if (Object.values(settings).some((value) => typeof value !== "string")) throw new Error("the MODEL_SETTINGS secret must map names to strings");
  if (!env.WALLET_KEYSTORE !== !env.WALLET_PASSWORD) throw new Error("set both WALLET_KEYSTORE and WALLET_PASSWORD, or neither");
  if (!env.WALLET_KEYSTORE || !env.WALLET_PASSWORD) return { config: env.TASKFAST_CONFIG, settings: settings as Record<string, string> };
  object(env.WALLET_KEYSTORE, "WALLET_KEYSTORE");
  // The Container rebuilds the kit's folder layout, so the config must name it.
  if (config.keystore_path !== ".taskfast/wallet.json") throw new Error('TASKFAST_CONFIG must have keystore_path ".taskfast/wallet.json" to sign');
  // Setup's password file is one line, saved as typed with no newline.
  if (/[\r\n]/.test(env.WALLET_PASSWORD)) throw new Error("the WALLET_PASSWORD secret must be one line");
  return { config: env.TASKFAST_CONFIG, settings: settings as Record<string, string>, wallet: { keystore: env.WALLET_KEYSTORE, password: env.WALLET_PASSWORD } };
}
