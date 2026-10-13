// The link `pnpm agents --console` prints, from the argument or TASKFAST_CONSOLE_URL.
// Errors never repeat the link: it holds the token.
const USAGE = "pnpm tui '<link printed by pnpm agents --console>', or set TASKFAST_CONSOLE_URL";
export function parseLink(arg: string | undefined, env: string | undefined): { origin: string; token: string } {
  const link = arg ?? env;
  if (!link) throw new Error(`no console link: ${USAGE}`);
  let url: URL;
  try { url = new URL(link); } catch { throw new Error(`not a console link: ${USAGE}`); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error(`the console runs on http://127.0.0.1 only: ${USAGE}`);
  const token = /^#token=([0-9a-f]{64})$/.exec(url.hash)?.[1];
  if (!token) throw new Error(`the link has no #token=: ${USAGE}`);
  return { origin: url.origin, token };
}
