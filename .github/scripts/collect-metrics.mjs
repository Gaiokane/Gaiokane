#!/usr/bin/env node
/**
 * 采集个人主页指标，写入 assets/metrics/*.json（shields.io endpoint 徽章格式）。
 *
 * 数据源全部是 GitHub 官方 API，不依赖任何第三方统计服务：
 *   GET /users/{user}                              → followers / 仓库数
 *   GET /users/{user}/repos?per_page=100           → 名下所有仓库的 star 之和
 *   GET /search/issues?q=repo:..+is:pr+author:..    → 向上游提的 PR（区分已合并 / 待审）
 *   GET /search/issues?q=repo:..+is:issue+author:.. → 向上游提的 issue
 *   GET /repos/{user}/{repo}/traffic/views          → 仓库 README 文件页浏览量（逐日累计）
 *
 * 说明：README 里的「主页访问量」徽章走的是 komarev 公共计数服务（每次主页渲染实时 +1），
 * 本脚本统计的是另一码事 —— 仓库 README blob 页的浏览量，两者口径不同，不要混用。
 *
 * 权限说明：traffic 接口要求仓库的 Administration: read，而 GITHUB_TOKEN 没有这个权限，
 * 所以「主页访问量」需要仓库 secret PROFILE_METRICS_TOKEN（细粒度 PAT：Administration → Read，
 * 仅本仓库；或经典 PAT 勾选 repo）。没配就跳过访问量统计、保留历史累计值，其余指标照常更新。
 *
 * 用法：node .github/scripts/collect-metrics.mjs
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const USER = process.env.GH_USER || "Gaiokane";
const REPO = process.env.GH_REPO || "Gaiokane";
const TOKEN = (process.env.GH_TOKEN || "").trim();
const API = "https://api.github.com";
const OUT_DIR = path.resolve("assets/metrics");
const STATE_FILE = path.join(OUT_DIR, "state.json");
const KEEP_DAYS = 400;

const UPSTREAMS = [
  { key: "dbx", repo: "t8y2/dbx", label: "dbx" },
  { key: "sp", repo: "Nnyjk/simple-post", label: "simple-post" },
];

/** shields.io endpoint 徽章的数据格式 */
function badge(label, message, color) {
  return { schemaVersion: 1, label, message: String(message), color };
}

async function api(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`GET ${url} -> ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** 翻页拉取列表接口 */
async function paginate(url) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const sep = url.includes("?") ? "&" : "?";
    const batch = await api(`${url}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function search(query) {
  return api(`${API}/search/issues?q=${encodeURIComponent(query)}&per_page=100`);
}

async function loadState() {
  if (!existsSync(STATE_FILE)) return { daily: {} };
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return { daily: parsed?.daily && typeof parsed.daily === "object" ? parsed.daily : {} };
  } catch {
    return { daily: {} };
  }
}

function sumDaily(daily) {
  return Object.values(daily).reduce((acc, v) => acc + (Number(v) || 0), 0);
}

/**
 * 访问量：GitHub 的 traffic 接口只保留最近 14 天，所以每天把「还没记过的日子」并进状态文件，
 * 状态文件里的历史不会被覆盖，也就不会重复计数。GitHub 偶尔回补某天的数据，取较大值。
 */
async function updateViews(state) {
  try {
    const traffic = await api(`${API}/repos/${USER}/${REPO}/traffic/views`);
    for (const row of traffic.views || []) {
      const day = String(row.timestamp).slice(0, 10);
      const count = Number(row.count) || 0;
      state.daily[day] = Math.max(Number(state.daily[day]) || 0, count);
    }
    const days = Object.keys(state.daily).sort();
    for (const day of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) {
      delete state.daily[day];
    }
    return { ok: true, total: sumDaily(state.daily) };
  } catch (err) {
    console.warn(`::warning::访问量统计跳过（traffic 接口不可用）：${err.message}`);
    return { ok: false, total: sumDaily(state.daily) };
  }
}

/** 统计某个上游仓库里我提的 PR：已合并 / 待审 / 总数 */
async function prStats(repo) {
  const data = await search(`repo:${repo} is:pr author:${USER}`);
  const items = data.items || [];
  const merged = items.filter((it) => it.pull_request?.merged_at).length;
  const open = items.filter((it) => it.state === "open").length;
  return { merged, open, total: data.total_count ?? items.length };
}

/** 统计某个上游仓库里我提的 issue */
async function issueStats(repo) {
  const data = await search(`repo:${repo} is:issue author:${USER}`);
  const items = data.items || [];
  const open = items.filter((it) => it.state === "open").length;
  return { open, total: data.total_count ?? items.length };
}

async function writeJson(file, value) {
  await writeFile(path.join(OUT_DIR, file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const state = await loadState();

  // 1) 账号概况 + 总 star
  const profile = await api(`${API}/users/${USER}`);
  const repos = await paginate(`${API}/users/${USER}/repos?type=owner`);
  const totalStars = repos.reduce((acc, r) => acc + (r.stargazers_count || 0), 0);
  console.log(
    `仓库数 ${profile.public_repos}（拉取到 ${repos.length} 个）· followers ${profile.followers} · 总 star ${totalStars}`,
  );

  // 2) 访问量（traffic 接口失败时保留历史累计值）
  const views = await updateViews(state);

  // 3) 上游贡献
  const upstream = {};
  for (const up of UPSTREAMS) {
    const prs = await prStats(up.repo);
    const issues = await issueStats(up.repo);
    upstream[up.key] = { ...up, prs, issues };
    console.log(`${up.label}：PR ${prs.merged} 合并 / ${prs.open} 待审（共 ${prs.total}）· issue ${issues.total}`);
  }

  // 4) 写出徽章数据
  // 仓库 README 文件页浏览量（不是主页渲染次数 —— 主页 README 是服务端内嵌渲染的，
  // 不会产生对 README blob 页的请求，所以这个数天然远小于真实主页访问量）
  await writeJson("views.json", badge("仓库 README 浏览量", views.total, "blue"));
  await writeJson("stars.json", badge("总 Star", totalStars, "yellow"));
  await writeJson(
    "dbx-prs.json",
    badge("dbx PR", `${upstream.dbx.prs.merged} 合并 · ${upstream.dbx.prs.open} 待审`, "blue"),
  );
  await writeJson("dbx-issues.json", badge("dbx Issue", upstream.dbx.issues.total, "blue"));
  await writeJson(
    "sp-prs.json",
    badge(
      "simple-post PR",
      `${upstream.sp.prs.merged} 合并 · ${upstream.sp.prs.open} 待审`,
      "blue",
    ),
  );
  await writeJson("state.json", { updatedAt: new Date().toISOString(), daily: state.daily });

  // 5) 写一份可读的汇总到 Actions 日志
  const rows = [
    "| 指标 | 数值 |",
    "| :--- | ---: |",
    `| 主页访问量 | ${views.total}${views.ok ? "" : "（traffic 接口不可用，保留历史值）"} |`,
    `| 总 Star | ${totalStars} |`,
    `| 仓库数 | ${profile.public_repos} |`,
    `| Followers | ${profile.followers} |`,
    `| dbx PR | ${upstream.dbx.prs.merged} 合并 · ${upstream.dbx.prs.open} 待审 |`,
    `| dbx Issue | ${upstream.dbx.issues.total} |`,
    `| simple-post PR | ${upstream.sp.prs.merged} 合并 · ${upstream.sp.prs.open} 待审 |`,
  ].join("\n");
  console.log(`\n${rows}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `${rows}\n`, { flag: "a" });
  }
}

main().catch((err) => {
  console.error(`::error::采集失败：${err.stack || err.message}`);
  process.exit(1);
});
