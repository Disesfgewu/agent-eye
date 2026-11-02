#!/usr/bin/env node
// Weekly watch on upstream browser-tool-for-agents projects (docs/ECOSYSTEM.md).
// Zero dependencies. Keeps ONE rolling issue (label "ecosystem") whose body holds
// the last-seen release tags in a hidden JSON comment, and comments when any of
// them changes. Idempotent: running twice in a row posts nothing the second time.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/ecosystem-watch.mjs [--dry-run]
//
// Safety: only tags matching SAFE_TAG are ever echoed into issue text, and release
// URLs are built by us — never copied from API responses — so a malicious release
// name/notes can't inject @mentions or links into our issues.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUE_TITLE = "Ecosystem watch (automated)";
const STATE_RE = /<!-- ecosystem-state: (\{[\s\S]*?\}) -->/;
// Plain tags ("v1.2.3", "release-5") or scoped-package tags ("@scope/pkg@1.2.3"); no whitespace,
// backticks, brackets or a bare leading "@mention".
const SAFE_TAG = /^(?!.{81})(@[a-z0-9][a-z0-9-]*\/)?[A-Za-z0-9][A-Za-z0-9._+\-/]*(@[A-Za-z0-9][A-Za-z0-9._+\-]*)?$/;

export function safeTag(tag) {
  return typeof tag === "string" && SAFE_TAG.test(tag) ? tag : "(unprintable tag)";
}

export function releaseUrl(repo, tag) {
  return `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
}

export function parseState(body) {
  const m = STATE_RE.exec(body ?? "");
  if (!m) return {};
  try {
    const parsed = JSON.parse(m[1]);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** latest: { "owner/repo": tag | null }. prev: { "owner/repo": tag }. */
export function diffReleases(prev, latest) {
  const changes = [];
  const baseline = [];
  const next = { ...prev };
  for (const [repo, tag] of Object.entries(latest)) {
    if (!tag) continue; // couldn't determine; keep the old value
    if (prev[repo] === undefined) baseline.push({ repo, to: tag });
    else if (prev[repo] !== tag) changes.push({ repo, from: prev[repo], to: tag });
    next[repo] = tag;
  }
  return { changes, baseline, next };
}

export function renderComment(changes, date) {
  const lines = [`**New upstream releases** (${date})`, ""];
  for (const c of changes) {
    lines.push(`- \`${c.repo}\`: \`${safeTag(c.from)}\` → [\`${safeTag(c.to)}\`](${releaseUrl(c.repo, c.to)})`);
  }
  lines.push("", "Please check `docs/ECOSYSTEM.md` for anything this changes (new token-saving features, new tools we lack, license/browser support).");
  return lines.join("\n");
}

export function renderBody(state, date) {
  const rows = Object.entries(state).map(([repo, tag]) => `| [${repo}](https://github.com/${repo}) | \`${safeTag(tag)}\` |`);
  return [
    "Rolling tracker for the projects listed in `docs/ecosystem-watch.json`. A weekly workflow comments here when one of them ships a new release.",
    "See [`docs/ECOSYSTEM.md`](../blob/main/docs/ECOSYSTEM.md) for the comparison and where Agent Eye stands.",
    "",
    `Last checked: ${date}`,
    "",
    "| project | last seen |",
    "|---|---|",
    ...rows,
    "",
    `<!-- ecosystem-state: ${JSON.stringify(state)} -->`,
  ].join("\n");
}

async function gh(token, apiPath, init = {}) {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "agent-eye-ecosystem-watch",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${apiPath} → ${res.status}`);
  return res.status === 204 ? {} : res.json();
}

/** Latest release tag, falling back to the newest tag for repos that don't publish releases. */
export async function latestTag(token, repo) {
  const rel = await gh(token, `/repos/${repo}/releases/latest`);
  if (rel?.tag_name) return rel.tag_name;
  const tags = await gh(token, `/repos/${repo}/tags?per_page=1`);
  return tags?.[0]?.name ?? null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const token = process.env.GITHUB_TOKEN;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const watch = JSON.parse(fs.readFileSync(path.join(here, "..", "docs", "ecosystem-watch.json"), "utf8"));
  const date = new Date().toISOString().slice(0, 10);

  const latest = {};
  for (const { repo } of watch.repos) {
    try {
      latest[repo] = await latestTag(token, repo);
    } catch (err) {
      console.error(`! ${repo}: ${err.message}`);
      latest[repo] = null;
    }
  }

  const self = process.env.GITHUB_REPOSITORY;
  let issue;
  if (self && token) {
    const open = await gh(token, `/repos/${self}/issues?labels=ecosystem&state=open&per_page=30`);
    issue = (open ?? []).find((i) => i.title === ISSUE_TITLE && !i.pull_request);
  }
  const prev = parseState(issue?.body);
  const { changes, baseline, next } = diffReleases(prev, latest);

  console.log(`checked ${watch.repos.length} repos: ${changes.length} changed, ${baseline.length} new baseline`);
  for (const c of changes) console.log(`  ${c.repo}: ${c.from} -> ${c.to}`);
  if (dryRun || !self || !token) {
    console.log(dryRun ? "(dry run: nothing written)" : "(no GITHUB_TOKEN/GITHUB_REPOSITORY: nothing written)");
    return;
  }

  const body = renderBody(next, date);
  if (!issue) {
    const created = await gh(token, `/repos/${self}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: ISSUE_TITLE, body, labels: ["ecosystem"] }),
    });
    console.log(`created tracking issue #${created.number} (baseline recorded)`);
    return;
  }
  if (changes.length) {
    await gh(token, `/repos/${self}/issues/${issue.number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: renderComment(changes, date) }),
    });
  }
  if (changes.length || baseline.length) {
    await gh(token, `/repos/${self}/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ body }) });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
