import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const WEEK_COUNT = 13;
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
const dateLabel = (date) => new Date(date).toISOString().slice(0, 10);

// Thirteen seven-day buckets, including the current (partial) UTC day.
export function activityWindow(now = new Date()) {
  const end = new Date(now);
  const today = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return { start: new Date(today - (WEEK_COUNT * 7 - 1) * DAY), end };
}

export function summarizeCommits(commits, repo, owner, { start, end }) {
  const weeks = Array(WEEK_COUNT).fill(0);
  const seen = new Set();
  let excludedRefreshes = 0;
  for (const item of commits) {
    if (seen.has(item.sha)) continue;
    seen.add(item.sha);
    const date = new Date(item.commit.author?.date).getTime();
    if (!Number.isFinite(date) || date < +start || date > +end) continue;
    // The old workflow authored these under the owner's identity.
    const legacyRefresh = repo.name.toLowerCase() === owner.toLowerCase()
      && item.commit.message.trim() === "Update recent commit activity";
    if (legacyRefresh) {
      excludedRefreshes += 1;
      continue;
    }
    if (item.author?.type === "Bot" || item.author?.login?.toLowerCase() !== owner.toLowerCase()) continue;
    const week = Math.floor((date - start) / WEEK);
    if (week >= 0 && week < WEEK_COUNT) weeks[week] += 1;
  }
  return { name: repo.name, count: weeks.reduce((sum, count) => sum + count, 0), weeks, excludedRefreshes };
}

export async function collectActivity(owner, window, request) {
  async function paged(path) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const batch = await request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error("Expected a GitHub API list");
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }
  const repos = (await paged(`/users/${encodeURIComponent(owner)}/repos?type=owner&sort=full_name`))
    .filter((repo) => !repo.fork && !repo.private && !repo.archived);
  const projects = [];
  let excludedRefreshes = 0;
  for (const repo of repos) {
    // Read the full author-filtered history. Git's query date and author date can
    // differ after rebases, so filtering "since" before bucketing can lose commits.
    const query = new URLSearchParams({ author: owner, sha: repo.default_branch });
    let commits;
    try {
      commits = await paged(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}/commits?${query}`);
    } catch (error) {
      if (error.status === 409 && /Git Repository is empty/i.test(error.message)) continue;
      throw error; // Never replace the graph with partial data after an API failure.
    }
    const project = summarizeCommits(commits, repo, owner, window);
    excludedRefreshes += project.excludedRefreshes;
    if (project.count) projects.push(project);
  }
  projects.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { projects, excludedRefreshes, total: projects.reduce((sum, p) => sum + p.count, 0) };
}

export function renderActivity({ projects, total }, { start, end }) {
  const height = 260 + Math.max(projects.length, 1) * 56;
  const maxCount = Math.max(1, ...projects.map((p) => p.count));
  const maxWeek = Math.max(1, ...projects.flatMap((p) => p.weeks));
  const rows = projects.map((project, row) => {
    const y = 207 + row * 56;
    const name = project.name.length > 26 ? project.name.slice(0, 25) + "…" : project.name;
    const cells = project.weeks.map((count, week) => {
      const from = +start + week * WEEK;
      const through = Math.min(from + WEEK - 1, +end);
      return `<rect x="${776 + week * 22}" y="${y - 14}" width="16" height="16" rx="4" fill="${count ? "#68e1c2" : "#202b35"}" opacity="${count ? (.25 + .75 * count / maxWeek).toFixed(3) : 1}"><title>${dateLabel(from)} to ${dateLabel(through)}: ${count} commits</title></rect>`;
    }).join("");
    return `<g>
      <title>${esc(project.name)}: ${project.count} commits</title>
      <text x="44" y="${y}" fill="#f0f6fc" font-size="18">${esc(name)}</text>
      <rect x="342" y="${y - 12}" width="364" height="12" rx="6" fill="#202b35"/>
      <rect x="342" y="${y - 12}" width="${(project.count / maxCount * 364).toFixed(2)}" height="12" rx="6" fill="#68e1c2"/>
      ${cells}
      <text x="1156" y="${y}" fill="#f0f6fc" font-size="20" font-weight="700" text-anchor="end">${project.count}</text>
    </g>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Public code activity — last 13 weeks</title>
  <desc id="desc">${total} authored commits across ${projects.length} repositories, ${dateLabel(start)} through ${dateLabel(end)} UTC. Owned public non-fork, non-archived repositories, default branches only. Generated profile refreshes excluded. ${esc(projects.map((p) => p.name + ": " + p.count).join("; "))}</desc>
  <rect x="1" y="1" width="1198" height="${height - 2}" rx="20" fill="#0d1117" stroke="#293441"/>
  <text x="44" y="42" fill="#98a9bc" font-family="monospace" font-size="13" letter-spacing="2">THE LAB / PUBLIC CODE ACTIVITY</text>
  <g font-family="Arial, Helvetica, sans-serif">
    <text x="42" y="99" fill="#f0f6fc" font-size="42" font-weight="700">${total}<tspan dx="12" fill="#a7b6c8" font-size="25" font-weight="400">authored commits</tspan></text>
    <text x="44" y="132" fill="#a7b6c8" font-size="17">${projects.length} repositories · 13 weeks · generated refreshes excluded</text>
    <text x="1156" y="91" fill="#68e1c2" font-size="16" text-anchor="end">${dateLabel(start)} — ${dateLabel(end)}</text>
    <text x="1156" y="118" fill="#98a9bc" font-size="14" text-anchor="end">Updated ${end.toISOString().slice(0, 16).replace("T", " ")} UTC</text>
    <path d="M44 151H1156" stroke="#293441"/>
    <g fill="#98a9bc" font-size="12" font-family="monospace" letter-spacing="1.5"><text x="44" y="177">REPOSITORY</text><text x="342" y="177">COMMITS / SAME SCALE</text><text x="776" y="177">WEEKLY ACTIVITY →</text><text x="1156" y="177" text-anchor="end">TOTAL</text></g>
    ${rows || '<text x="600" y="218" fill="#a7b6c8" font-size="20" text-anchor="middle">No matching commits in this window.</text>'}
    <path d="M44 ${height - 63}H1156" stroke="#293441"/>
    <text x="44" y="${height - 31}" fill="#98a9bc" font-size="14">Default branches · author dates in UTC · latest week is partial</text>
    <text x="1156" y="${height - 31}" fill="#98a9bc" font-size="14" text-anchor="end">Weekly color: 0 → ${maxWeek} commits · shared scale</text>
  </g>
</svg>\n`;
}

async function main() {
  const owner = process.env.GITHUB_OWNER || "jonahchang207";
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": `${owner}-profile-activity`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const request = async (path) => {
    const response = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  const window = activityWindow();
  const activity = await collectActivity(owner, window, request);
  const output = process.env.OUTPUT_PATH || "assets/recent-commits.svg";
  await writeFile(output, renderActivity(activity, window), "utf8");
  console.log(JSON.stringify({ output, start: window.start, end: window.end, ...activity }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
