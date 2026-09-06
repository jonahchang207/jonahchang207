import { writeFile } from "node:fs/promises";

const owner = process.env.GITHUB_OWNER || "jonahchang207";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const output = process.env.OUTPUT_PATH || "assets/recent-commits.svg";
const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": `${owner}-profile-activity`,
  "X-GitHub-Api-Version": "2022-11-28",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

const end = new Date();
const start = new Date(end);
start.setUTCMonth(start.getUTCMonth() - 3);
start.setUTCHours(0, 0, 0, 0);

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json();
}

async function paged(path) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await github(`${path}${separator}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

const repos = (await paged(`/users/${owner}/repos?sort=updated&type=owner`))
  .filter((repo) => !repo.fork && !repo.archived);
const activity = [];

for (const repo of repos) {
  const commits = await paged(`/repos/${owner}/${encodeURIComponent(repo.name)}/commits?author=${owner}&since=${start.toISOString()}&until=${end.toISOString()}`);
  if (!commits.length) continue;
  const weeks = Array(13).fill(0);
  for (const commit of commits) {
    const date = new Date(commit.commit.author?.date || commit.commit.committer?.date);
    const index = Math.min(12, Math.max(0, Math.floor((date - start) / 604800000)));
    weeks[index] += 1;
  }
  activity.push({ name: repo.name, url: repo.html_url, count: commits.length, weeks });
}

activity.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
const total = activity.reduce((sum, project) => sum + project.count, 0);
const max = Math.max(1, ...activity.map((project) => project.count));
const rowHeight = 64;
const height = 176 + Math.max(activity.length, 1) * rowHeight;
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
const shortDate = (date) => date.toISOString().slice(0, 10);

const rows = activity.length ? activity.map((project, row) => {
  const y = 160 + row * rowHeight;
  const width = Math.max(12, Math.round((project.count / max) * 470));
  const cells = project.weeks.map((count, week) => {
    const opacity = count ? Math.min(1, .24 + count / Math.max(...project.weeks, 1) * .76) : .1;
    return `<rect x="${810 + week * 20}" y="${y - 17}" width="14" height="14" rx="3" fill="#68e1c2" opacity="${opacity.toFixed(2)}"/>`;
  }).join("");
  return `<g font-family="monospace">
    <a href="${esc(project.url)}"><text x="56" y="${y}" fill="#f0f6fc" font-size="17" font-weight="700">${esc(project.name)}</text></a>
    <rect x="300" y="${y - 15}" width="470" height="18" fill="#20283a"/>
    <rect class="bar" x="300" y="${y - 15}" width="${width}" height="18" rx="5" fill="#a8bfff"/>
    ${cells}
    <text x="1144" y="${y}" fill="#68e1c2" font-size="18" font-weight="800" text-anchor="end">${project.count}</text>
  </g>`;
}).join("\n") : `<text x="600" y="180" fill="#a7b6c8" font-family="monospace" font-size="18" text-anchor="middle">No authored commits in this window</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Commits by project over the last three months</title>
  <desc id="desc">${total} commits authored by ${esc(owner)} across ${activity.length} active projects from ${shortDate(start)} through ${shortDate(end)}.</desc>
  <style>.bar{animation:reveal 1.4s ease-out both;transform-box:fill-box;transform-origin:left}@keyframes reveal{from{transform:scaleX(0)}to{transform:scaleX(1)}}@media(prefers-reduced-motion:reduce){.bar{animation:none}}</style>
  <rect x="1" y="1" width="1198" height="${height - 2}" rx="20" fill="#0d1117" stroke="#293441"/>
  <g stroke="#a7b6c8" stroke-width="1" opacity=".07"><path d="M0 70h1200M0 126h1200"/><path d="M280 0v${height}M790 0v${height}M1100 0v${height}"/></g>
  <g font-family="monospace">
    <text x="56" y="48" fill="#a7b6c8" font-size="15" font-weight="700" letter-spacing="3">LAST THREE MONTHS / BY PROJECT</text>
    <text x="56" y="102" fill="#f0f6fc" font-size="38" font-weight="800">${total} COMMITS</text>
    <text x="1144" y="93" fill="#68e1c2" font-size="16" font-weight="700" text-anchor="end">${activity.length} ACTIVE PROJECT${activity.length === 1 ? "" : "S"}</text>
    <text x="1144" y="116" fill="#a7b6c8" font-size="12" text-anchor="end">${shortDate(start)} / ${shortDate(end)}</text>
    <text x="300" y="142" fill="#a7b6c8" opacity=".65" font-size="11" letter-spacing="2">RELATIVE VOLUME</text>
    <text x="810" y="142" fill="#a7b6c8" opacity=".65" font-size="11" letter-spacing="2">WEEKLY SIGNAL</text>
    <text x="1144" y="142" fill="#a7b6c8" opacity=".65" font-size="11" text-anchor="end" letter-spacing="2">COMMITS</text>
  </g>
  ${rows}
</svg>\n`;

await writeFile(output, svg, "utf8");
console.log(`Wrote ${output}: ${total} commits across ${activity.length} projects.`);
