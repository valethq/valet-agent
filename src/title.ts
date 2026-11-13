export function titleFrom(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith("/")) return null;
  const line = (trimmed.split("\n").find((l) => l.trim() !== "") ?? "")
    .replace(/^[#>*`\s-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (line === "") return null;
  if (line.length <= 60) return line;
  const cut = line.lastIndexOf(" ", 60);
  return `${line.slice(0, cut > 0 ? cut : 60)}…`;
}
