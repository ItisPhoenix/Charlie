import type { AdapterContext } from "@rakazo/adapter-kit";
import { fetchSafeWebText } from "./web-ssrf.js";

/**
 * Public, pinned GitHub source access without repository-wide tree truncation,
 * code-search sign-in, shell execution, or authentication secrets.
 * The shared safe HTTP transport validates public DNS addresses at each hop.
 */
function target(args: Record<string, unknown>) {
  const repository = String(
    args.repository ?? process.env.CHARLIE_SOURCE_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "",
  ).trim();
  const commit = String(
    args.commit ??
      (repository === process.env.CHARLIE_SOURCE_REPOSITORY ? process.env.GIT_SHA : "") ??
      "",
  ).trim();
  const path = String(args.path ?? "")
    .trim()
    .replace(/\/$/, "");
  const [owner, name, extra] = repository.split("/");
  const validPart = (part: string | undefined) =>
    !!part && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(part) && !part.includes("..");
  if (
    !validPart(owner) ||
    !validPart(name) ||
    extra ||
    (commit !== "" && !/^[a-fA-F0-9]{40}$/.test(commit))
  ) {
    throw new Error("Repository source is not configured or source ref invalid.");
  }
  if (
    path.length > 400 ||
    path.startsWith("/") ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || !/^[a-zA-Z0-9_.@+-]+$/.test(part))
  ) {
    if (path !== "") throw new Error("Invalid repository-relative source path");
  }
  const sourcePath = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return { repository, owner, name, commit, path, sourcePath };
}

async function resolveTarget(ctx: AdapterContext, args: Record<string, unknown>) {
  const t = target(args);
  if (t.commit) return t;
  // Resolve a public repository's current default head to one immutable SHA.
  // The resolved SHA accompanies every response for subsequent source reads.
  const res = await fetchSafeWebText(
    "https://api.github.com/repos/" + t.owner + "/" + t.name + "/commits?per_page=1",
    {
      signal: ctx.signal,
      timeoutMs: 12000,
      maxBytes: 128 * 1024,
      headers: { Accept: "application/vnd.github+json" },
    },
  );
  const history: unknown = JSON.parse(res.body);
  if (!Array.isArray(history) || !history[0] || typeof history[0] !== "object")
    throw new Error("Could not resolve source revision");
  const commit = (history[0] as { sha?: unknown }).sha;
  if (typeof commit !== "string" || !/^[a-fA-F0-9]{40}$/.test(commit))
    throw new Error("Source revision is missing");
  return { ...t, commit };
}

export async function githubSourceList(ctx: AdapterContext, args: Record<string, unknown>) {
  try {
    const t = await resolveTarget(ctx, args);
    const url =
      "https://api.github.com/repos/" +
      t.owner +
      "/" +
      t.name +
      "/contents" +
      (t.sourcePath ? "/" + t.sourcePath : "") +
      "?ref=" +
      t.commit;
    const response = await fetchSafeWebText(url, {
      signal: ctx.signal,
      timeoutMs: 15000,
      maxBytes: 2 * 1024 * 1024,
      headers: { Accept: "application/vnd.github+json" },
    });
    const result: unknown = JSON.parse(response.body);
    if (!Array.isArray(result)) return { error: "Path is not a directory" };
    const filter = String(args.filter ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 80);
    const matches = result
      .filter(
        (x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x),
      )
      .filter(
        (x) =>
          (x.type === "file" || x.type === "dir") &&
          typeof x.path === "string" &&
          typeof x.name === "string",
      )
      .filter((x) => !filter || String(x.path).toLowerCase().includes(filter));
    const offset = Number(args.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > matches.length) {
      return { error: "offset must be a nonnegative index within the directory results" };
    }
    const entries = matches.slice(offset, offset + 200).map((x) => ({
      name: x.name,
      path: x.path,
      type: x.type,
    }));
    return {
      repository: t.repository,
      commit: t.commit,
      directory: t.path || "/",
      entries,
      totalMatches: matches.length,
      offset,
      nextOffset: offset + entries.length < matches.length ? offset + entries.length : null,
      note: "Use filter or nextOffset to navigate; github_source_find searches paths across directories.",
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Find matching paths across directories without returning or truncating a
 * complete repository tree to the model. Never claim exhaustive results if
 * GitHub reports that its tree data is incomplete.
 */
export async function githubSourceFind(ctx: AdapterContext, args: Record<string, unknown>) {
  try {
    const t = await resolveTarget(ctx, args);
    const query = String(args.query ?? "")
      .trim()
      .toLowerCase();
    if (query.length < 2 || query.length > 100) {
      return { error: "query must have 2-100 characters" };
    }
    const directory = String(args.directory ?? "")
      .trim()
      .replace(/\/$/, "");
    if (
      directory &&
      (directory.startsWith("/") ||
        directory.length > 400 ||
        directory
          .split("/")
          .some((x) => !x || x === "." || x === ".." || !/^[a-zA-Z0-9_.@+-]+$/.test(x)))
    ) {
      return { error: "Invalid source directory" };
    }
    const offset = Number(args.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000) {
      return { error: "offset must be between 0 and 100000" };
    }
    const url =
      "https://api.github.com/repos/" +
      t.owner +
      "/" +
      t.name +
      "/git/trees/" +
      t.commit +
      "?recursive=1";
    const response = await fetchSafeWebText(url, {
      signal: ctx.signal,
      timeoutMs: 20000,
      maxBytes: 3 * 1024 * 1024,
      headers: { Accept: "application/vnd.github+json" },
    });
    const result: unknown = JSON.parse(response.body);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return { error: "GitHub did not return a source tree" };
    }
    const data = result as { tree?: unknown; truncated?: unknown };
    if (data.truncated !== false || !Array.isArray(data.tree)) {
      return {
        error: "Repository tree is incomplete; narrow the directory using github_source_list",
      };
    }
    const tokens = query
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const score = (path: string) => {
      const text = path.toLowerCase().replace(/[^a-z0-9]+/g, " ");
      return tokens.reduce((n, token) => n + Number(text.includes(token)), 0);
    };
    const matches = data.tree
      .filter(
        (v): v is { path: string; type: string } =>
          !!v &&
          typeof v === "object" &&
          typeof v.path === "string" &&
          (v.type === "blob" || v.type === "tree"),
      )
      .filter((v) => (!directory || v.path.startsWith(directory + "/")) && score(v.path) > 0)
      .sort((a, b) => score(b.path) - score(a.path) || a.path.localeCompare(b.path));
    const entries = matches.slice(offset, offset + 100).map((v) => ({
      path: v.path,
      type: v.type === "tree" ? "dir" : "file",
    }));
    return {
      repository: t.repository,
      commit: t.commit,
      query,
      directory: directory || "/",
      totalMatches: matches.length,
      entries,
      offset,
      nextOffset: offset + entries.length < matches.length ? offset + entries.length : null,
      note: "Search matches paths and filenames, not file content. Use github_source_read to inspect a result.",
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function githubSourceRead(ctx: AdapterContext, args: Record<string, unknown>) {
  try {
    const t = await resolveTarget(ctx, args);
    if (!t.path) return { error: "A file path is required" };
    const url =
      "https://raw.githubusercontent.com/" +
      t.owner +
      "/" +
      t.name +
      "/" +
      t.commit +
      "/" +
      t.sourcePath;
    const response = await fetchSafeWebText(url, {
      signal: ctx.signal,
      timeoutMs: 12000,
      maxBytes: 768 * 1024,
    });
    const lines = response.body.replace(/\r\n/g, "\n").split("\n");
    const find = String(args.find ?? "")
      .trim()
      .toLowerCase();
    if (find.length > 120) return { error: "find must be 120 characters or less" };
    const matchLines = find
      ? lines.flatMap((line, i) => (line.toLowerCase().includes(find) ? [i + 1] : []))
      : [];
    if (find && !matchLines.length) {
      return {
        repository: t.repository,
        commit: t.commit,
        path: t.path,
        error: "Text was not found in file",
        totalLines: lines.length,
      };
    }
    const start = Number(args.startLine ?? matchLines[0] ?? 1);
    const count = Number(args.lineCount ?? 120);
    if (
      !Number.isInteger(start) ||
      start < 1 ||
      start > lines.length ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 200
    ) {
      return { error: "startLine must be a valid source line and lineCount must be 1–200" };
    }
    const excerpt = lines
      .slice(start - 1, start - 1 + count)
      .map((line, i) => String(start + i).padStart(5) + " | " + line)
      .join("\n");
    return {
      repository: t.repository,
      commit: t.commit,
      path: t.path,
      url,
      startLine: start,
      endLine: Math.min(lines.length, start + count - 1),
      totalLines: lines.length,
      matchLines: matchLines.slice(0, 40),
      code: excerpt.slice(0, 29000),
      truncated: excerpt.length > 29000 || start + count - 1 < lines.length,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
