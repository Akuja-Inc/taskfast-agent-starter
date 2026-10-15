// The markdown subset the console and the terminal UI draw in agent replies: paragraphs,
// bold, italic, inline and fenced code, `-` and `1.` lists one level deep, http(s) links,
// and headings as bold paragraphs. Everything else, raw HTML and other link schemes
// included, stays text. Every newline inside a paragraph is a line break, as the model
// wrote it. A reply still streaming ends mid-construct, so an open fence, code span or
// `*` emphasis closes at the end of its block instead of showing its marker. The page
// embeds this function's source, so it closes over nothing.
export type Run = { text: string; strong?: true; em?: true; code?: true; href?: string };
export type List = { kind: "list"; start?: number; items: { runs: Run[]; list?: List }[] };
export type Block = { kind: "p"; runs: Run[] } | { kind: "code"; text: string } | List;

export function markdown(text: string): Block[] {
  type Style = Omit<Run, "text">;
  const word = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  const space = (c: string | undefined) => c === undefined || /\s/.test(c);
  function inline(src: string, base: Style): Run[] {
    const runs: Run[] = [];
    const style: Style = { ...base };
    let buf = "";
    const flush = () => { if (buf) runs.push({ text: buf, ...style }); buf = ""; };
    // _ never opens or closes inside a word (snake_case_id), and opens only when it closes
    // later. ponytail: that lookahead is quadratic in underscores; replies are short.
    const closes = (mark: string, from: number) => {
      for (let j = src.indexOf(mark, from); j >= 0; j = src.indexOf(mark, j + 1)) if (!space(src[j - 1]) && !word(src[j + mark.length])) return true;
      return false;
    };
    for (let i = 0; i < src.length;) {
      const c = src[i], rest = src.slice(i);
      if (c === "\\" && /^\\[!-/:-@[-`{-~]/.test(rest)) { buf += src[i + 1]; i += 2; continue; }
      if (c === "`") {
        const tick = /^`+/.exec(rest)![0], end = src.indexOf(tick, i + tick.length);
        flush();
        const body = src.slice(i + tick.length, end < 0 ? undefined : end);
        if (body) runs.push({ text: body, ...style, code: true });
        i = end < 0 ? src.length : end + tick.length;
        continue;
      }
      // No images: the whole image syntax stays text, so nothing links to its address.
      const image = c === "!" ? /^!\[[^\]\n]*\]\([^)\n]*\)/.exec(rest) : null;
      if (image) { buf += image[0]; i += image[0].length; continue; }
      // The link's words, without their own markers, become one run.
      const link = c === "[" ? /^\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/i.exec(rest) : null;
      if (link) {
        flush();
        runs.push({ ...style, text: inline(link[1], {}).map((run) => run.text).join(""), href: link[2] });
        i += link[0].length;
        continue;
      }
      if (c === "*" || c === "_") {
        const mark = rest.startsWith(c + c) ? c + c : c, key = mark.length === 2 ? "strong" : "em";
        const before = src[i - 1], after = src[i + mark.length];
        const close = style[key] && !space(before) && !(c === "_" && word(after));
        // _ and a * inside a word (5*3) open only when they close later; a * after a space
        // opens at once, so a streaming *word shows no marker.
        const open = !style[key] && !space(after) && !(c === "_" && word(before)) && !((c === "_" || word(before)) && !closes(mark, i + mark.length));
        if (close || open) {
          flush();
          if (close) delete style[key]; else style[key] = true;
          i += mark.length;
          continue;
        }
        // A * that ends the text is the next marker still streaming: drop it.
        if (c === "*" && i + mark.length === src.length) break;
      }
      buf += c;
      i++;
    }
    flush();
    return runs;
  }

  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  // Items collect their lines as text and are parsed once their list is complete.
  type Raw = { start?: number; items: { text: string; list?: Raw }[] };
  let list: Raw | null = null;
  const lists: [List, Raw][] = [];
  const end = () => {
    if (para.length) blocks.push({ kind: "p", runs: inline(para.join("\n"), {}) });
    para = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      end();
      const body: string[] = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i]);
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    // A blank line or a rule (*** or ---) ends the block; the subset draws no rules.
    if (!line.trim() || /^ {0,3}([-*_])( *\1){2,} *$/.test(line)) { end(); continue; }
    const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      end();
      blocks.push({ kind: "p", runs: inline(heading[1], {}).map((run) => ({ ...run, strong: true })) });
      continue;
    }
    const item = /^(\s*)(?:[-*+]|(\d{1,9})[.)])\s+(.*)$/.exec(line);
    // Only "1." starts a numbered list inside a paragraph, so "2024. was a year" stays prose.
    if (item && !(para.length && item[2] !== undefined && item[2] !== "1")) {
      const start = item[2] === undefined ? undefined : Number(item[2]);
      const parent: Raw | null = list;
      const last = parent && parent.items[parent.items.length - 1];
      // An indented item nests under the item before it; deeper ones join that same level.
      if (last && item[1].length >= 2) {
        (last.list ??= { start, items: [] }).items.push({ text: item[3] });
        continue;
      }
      if (!parent || (parent.start === undefined) !== (start === undefined)) {
        end();
        const raw: Raw = { start, items: [] }, block: List = { kind: "list", items: [] };
        if (start !== undefined) block.start = start;
        blocks.push(block);
        lists.push([block, raw]);
        list = raw;
      }
      list!.items.push({ text: item[3] });
      continue;
    }
    // A plain line after an item continues that item, nested or not.
    if (list) {
      const last = list.items[list.items.length - 1], inner = last.list ? last.list.items[last.list.items.length - 1] : last;
      inner.text += "\n" + line.trim();
      continue;
    }
    para.push(line.trim());
  }
  end();
  const parse = (raw: Raw): List => ({ kind: "list", ...(raw.start === undefined ? {} : { start: raw.start }), items: raw.items.map((item) => ({ runs: inline(item.text, {}), ...(item.list ? { list: parse(item.list) } : {}) })) });
  for (const [block, raw] of lists) Object.assign(block, parse(raw));
  return blocks;
}
