function bracketEnd(source: string, start: number): number {
  let j = start + 1;
  if (j < source.length && (source[j] === "!" || source[j] === "^")) j++;
  if (j < source.length && source[j] === "]") j++;
  let esc = false;
  while (j < source.length) {
    const c = source[j]!;
    if (esc) {
      esc = false;
      j++;
      continue;
    }
    if (c === "\\") {
      esc = true;
      j++;
      continue;
    }
    if (c === "]") return j;
    j++;
  }
  return -1;
}
function globPartToSource(glob: string): string {
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "\\" && i + 1 < glob.length) {
      const next = glob[i + 1]!;
      source += next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 2;
      continue;
    }
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") {
          i += 1;
          source += "(?:.*\\/)?";
        } else {
          source += ".*";
        }
        continue;
      }
      source += ".*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      let esc = false;
      while (j < glob.length && depth > 0) {
        const c = glob[j]!;
        if (esc) {
          esc = false;
          j++;
          continue;
        }
        if (c === "\\") {
          esc = true;
          j++;
          continue;
        }
        if (c === "[") {
          const e = bracketEnd(glob, j);
          if (e >= 0) {
            j = e + 1;
            continue;
          }
          j++;
          continue;
        }
        if (c === "{") depth++;
        else if (c === "}") depth--;
        if (depth === 0) break;
        j++;
      }
      if (depth !== 0) {
        source += "\\{";
        i++;
        continue;
      }
      const inner = glob.slice(i + 1, j);
      const parts: string[] = [];
      let cur = "";
      let d2 = 0;
      let esc2 = false;
      for (let k = 0; k < inner.length; k++) {
        const c = inner[k]!;
        if (esc2) {
          cur += c;
          esc2 = false;
          continue;
        }
        if (c === "\\") {
          esc2 = true;
          cur += c;
          continue;
        }
        if (c === "[") {
          const e = bracketEnd(inner, k);
          if (e >= 0) {
            cur += inner.slice(k, e + 1);
            k = e;
            continue;
          }
          cur += c;
          continue;
        }
        if (c === "{") {
          d2++;
          cur += c;
          continue;
        }
        if (c === "}") {
          d2--;
          cur += c;
          continue;
        }
        if (c === "," && d2 === 0) {
          parts.push(cur);
          cur = "";
          continue;
        }
        cur += c;
      }
      parts.push(cur);
      if (parts.length <= 1) {
        source += "\\{" + globPartToSource(inner) + "\\}";
      } else {
        source += "(?:" + parts.map((p) => globPartToSource(p)).join("|") + ")";
      }
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      if (j < glob.length && (glob[j] === "!" || glob[j] === "^")) j++;
      if (j < glob.length && glob[j] === "]") j++;
      let esc3 = false;
      while (j < glob.length) {
        const c = glob[j]!;
        if (esc3) {
          esc3 = false;
          j++;
          continue;
        }
        if (c === "\\") {
          esc3 = true;
          j++;
          continue;
        }
        if (c === "]") break;
        j++;
      }
      if (j >= glob.length) {
        source += "\\[";
        i++;
        continue;
      }
      let content = glob.slice(i + 1, j);
      if (content.startsWith("!")) content = "^" + content.slice(1);
      if (content.startsWith("]") || content.startsWith("^]")) {
        if (content.startsWith("^]")) content = "^\\]" + content.slice(2);
        else content = "\\]" + content.slice(1);
      }
      if (content.startsWith("^") && !content.includes("/")) content = "^/" + content.slice(1);
      source += "[" + content + "]";
      i = j + 1;
      continue;
    }
    source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return source;
}
export function globToRegex(glob: string): RegExp {
  if (glob.startsWith("/")) glob = glob.slice(1);
  return new RegExp(`^${globPartToSource(glob)}$`);
}
