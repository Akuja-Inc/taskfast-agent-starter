// One Notes module: everything about the agent's notes lives here. Numbers are
// 1-based, as the prompt shows them. Every note is stored and rendered as one
// line, so no note can forge a prompt line of its own.
export function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

export function addNote(notes: string[], text: string): void {
  notes.push(oneLine(text));
}

export function replaceNote(notes: string[], number: number, text: string): void {
  if (number >= 1 && number <= notes.length) notes[number - 1] = oneLine(text);
}

export function removeNote(notes: string[], number: number): void {
  if (number >= 1 && number <= notes.length) notes.splice(number - 1, 1);
}

// Renders as one line per note, collapsing any note stored multi-line before
// this module existed.
export function renderNotes(notes: readonly string[]): string {
  if (!notes.length) return "";
  return `\nYour notes:\n${notes.map((note, index) => `${index + 1}: ${oneLine(note)}`).join("\n")}`;
}
