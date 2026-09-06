import test from 'node:test';
import assert from 'node:assert/strict';
import { activityWindow, summarizeCommits, collectActivity, renderActivity } from './generate-recent-commits.mjs';

const owner = 'jonahchang207';
const window = activityWindow(new Date('2026-09-06T12:00:00Z'));
function commit(sha, date, message = 'Build robot', login = owner) {
  return { sha, author: { login, type: 'User' }, commit: {
    author: { date }, committer: { date: '2026-09-06T12:00:00Z' }, message,
  } };
}

test('91 UTC calendar dates remain exactly 13 buckets across leap days and month ends', () => {
  for (const now of ['2026-09-06T12:00:00Z', '2024-03-31T23:59:59Z', '2026-01-01T00:00:00Z']) {
    const range = activityWindow(new Date(now));
    assert.equal((Date.parse(now.slice(0, 10)) - range.start) / 86400000, 90);
    assert.equal(range.start.getUTCHours(), 0);
  }
  assert.equal(window.start.toISOString(), '2026-06-08T00:00:00.000Z');
});

test('author dates, boundaries, identity and duplicate SHAs determine the count', () => {
  const result = summarizeCommits([
    commit('old', '2026-06-07T23:59:59Z'),
    commit('start', '2026-06-08T00:00:00Z'),
    commit('start', '2026-06-08T00:00:00Z'),
    commit('week-two', '2026-06-15T00:00:00Z'),
    commit('end', '2026-09-06T12:00:00Z'),
    commit('future', '2026-09-06T12:00:01Z'),
    commit('other', '2026-09-05T00:00:00Z', 'Other author', 'someone-else'),
    commit('invalid', 'not-a-date'),
  ], { name: 'odyssey' }, owner, window);
  assert.equal(result.count, 3);
  assert.deepEqual(result.weeks, [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

test('legacy refresh exclusion is restricted to the profile repository and exact message', () => {
  const refresh = commit('refresh', '2026-09-05T00:00:00Z', 'Update recent commit activity');
  const profile = summarizeCommits([refresh, commit('human', '2026-09-05T00:00:00Z', 'Fix recent commit activity')], { name: owner }, owner, window);
  assert.equal(profile.count, 1);
  assert.equal(profile.excludedRefreshes, 1);
  assert.equal(summarizeCommits([refresh], { name: 'odyssey' }, owner, window).count, 1);
});

test('pagination includes older pages, filters repository scope, and uses author history', async () => {
  const requests = [];
  const data = await collectActivity(owner, window, async (path) => {
    requests.push(path);
    if (path.startsWith('/users/')) return [
      { name: 'odyssey', default_branch: 'main' },
      { name: 'fork', fork: true }, { name: 'private', private: true }, { name: 'archived', archived: true },
    ];
    assert.match(path, /sha=main/);
    assert.doesNotMatch(path, /since=|until=/);
    if (path.endsWith('page=1')) return Array.from({ length: 100 }, (_, i) => commit(String(i), '2025-01-01T00:00:00Z'));
    return [commit('recent-author-old-history', '2026-09-01T00:00:00Z')];
  });
  assert.equal(requests.length, 3);
  assert.equal(data.total, 1);
  assert.equal(data.projects[0].weeks[12], 1);
});

test('empty repositories are skipped but access failures abort rather than undercount', async () => {
  for (const status of [409, 403]) {
    const run = collectActivity(owner, window, async (path) => {
      if (path.startsWith('/users/')) return [{ name: 'empty', default_branch: 'main' }];
      throw Object.assign(new Error(status === 409 ? 'Git Repository is empty.' : 'Rate limit exceeded'), { status });
    });
    if (status === 409) assert.equal((await run).total, 0);
    else await assert.rejects(run, /Rate limit/);
  }
});

test('render keeps totals, shared heat scale, escaped names and empty state readable', () => {
  const projects = [
    { name: 'A<&', count: 10, weeks: [2, 8, ...Array(11).fill(0)] },
    { name: 'B', count: 2, weeks: [2, ...Array(12).fill(0)] },
  ];
  const svg = renderActivity({ projects, total: 12 }, window);
  assert.match(svg, /A&lt;&amp;/);
  assert.equal((svg.match(/opacity="0.438"/g) || []).length, 2);
  assert.match(svg, /0 → 8 commits/);
  assert.match(svg, /12<tspan/);
  assert.match(renderActivity({ projects: [], total: 0 }, window), /No matching commits/);
});
