#!/usr/bin/env bash
# 生成静态统计卡到 assets/ 目录。
#
# 读者打开主页时读到的是仓库里的静态 SVG，不会实时请求任何第三方服务；
# 只有这个每天跑一次的 workflow 会去拉一次。公共实例临时挂掉也不会让主页出现破图 ——
# 拉不到就保留上一次的图，首次就拉不到则写入一张说明用的占位图。
#
# 想彻底自托管：把仓库变量 STATS_BASE_URL 指向自己的部署（GitHub Stats Extended 支持
# Docker / Vercel 自建），留空则用公共实例。

set -uo pipefail

BASE_URL="${STATS_BASE_URL:-https://github-stats-extended.vercel.app}"
USER="${GH_USER:-Gaiokane}"
TIMEOUT="${CARD_TIMEOUT:-60}"

mkdir -p assets

# 占位图：只在从未成功生成过卡片时使用，避免主页出现破图
placeholder() {
  local out="$1" title="$2" width="$3"
  cat >"$out" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="120" role="img" aria-label="${title}">
  <rect width="${width}" height="120" rx="6" fill="#1b1f23"/>
  <text x="20" y="55" fill="#c9d1d9" font-family="DejaVu Sans,Segoe UI,Verdana,sans-serif" font-size="16">${title}</text>
  <text x="20" y="82" fill="#8b949e" font-family="DejaVu Sans,Segoe UI,Verdana,sans-serif" font-size="12">尚未生成 —— workflow 每天会自动刷新</text>
</svg>
SVG
}

fetch_card() {
  local url="$1" out="$2" title="$3" width="$4"
  local tmp
  tmp="$(mktemp)"
  if curl -fsSL --max-time "$TIMEOUT" -A "profile-readme-cards" "$url" -o "$tmp" 2>/dev/null &&
    grep -qi "<svg" "$tmp"; then
    mv "$tmp" "$out"
    echo "::notice::已更新 ${out}"
    return 0
  fi
  rm -f "$tmp"
  echo "::warning::统计卡拉取失败：${url}"
  if [ ! -s "$out" ]; then
    placeholder "$out" "$title" "$width"
    echo "::warning::已写入占位图 ${out}"
  fi
  return 0
}

fetch_card \
  "${BASE_URL}/api?username=${USER}&show_icons=true&theme=onedark&hide=issues,contribs" \
  "assets/stats.svg" "GitHub Stats" "430"

fetch_card \
  "${BASE_URL}/api/top-langs?username=${USER}&layout=compact&theme=onedark" \
  "assets/top-langs.svg" "Top Languages" "300"
