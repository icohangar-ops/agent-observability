import { createElement, type ReactNode } from "react";

// Pretty-print JSON-looking strings so large tool payloads are readable; leave
// plain text (and anything that doesn't parse) untouched. `isJson` tells the
// renderer whether to apply syntax highlighting.
export function prettyPrint(value: string): {
  text: string;
  isJson: boolean;
  data?: unknown;
} {
  const trimmed = value.trim();
  const looksJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (!looksJson) return { text: value, isJson: false };
  try {
    const parsed = JSON.parse(trimmed);
    return { text: JSON.stringify(parsed, null, 2), isJson: true, data: parsed };
  } catch {
    return { text: value, isJson: false };
  }
}

// Matches JSON tokens: strings, true/false/null, and numbers. Everything else
// (braces, commas, colons, whitespace) is emitted verbatim as punctuation.
export const JSON_TOKEN_RE =
  /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

// Color-code pretty-printed JSON into themed spans. Theme-aware via Tailwind
// dark: variants so it stays legible in both light and dark mode.
export function highlightJson(code: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  JSON_TOKEN_RE.lastIndex = 0;
  while ((match = JSON_TOKEN_RE.exec(code)) !== null) {
    const token = match[0];
    const start = match.index;
    if (start > last) nodes.push(code.slice(last, start));
    let cls: string;
    if (token[0] === '"') {
      cls = /^\s*:/.test(code.slice(start + token.length))
        ? "text-sky-700 dark:text-sky-300"
        : "text-emerald-600 dark:text-emerald-400";
    } else if (token === "true" || token === "false") {
      cls = "text-violet-600 dark:text-violet-400";
    } else if (token === "null") {
      cls = "text-rose-600 dark:text-rose-400";
    } else {
      cls = "text-amber-600 dark:text-amber-400";
    }
    nodes.push(createElement("span", { key: key++, className: cls }, token));
    last = start + token.length;
  }
  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}
