import fs from "node:fs/promises";

const username = process.env.GITHUB_USERNAME || "mindovermattr";
const githubToken = process.env.GITHUB_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;
const githubApiBase = "https://api.github.com";
const openaiApiBase = "https://api.openai.com/v1";
const readmePath = "README.md";
const managedStart = "<!-- auto:github-profile:start -->";
const managedEnd = "<!-- auto:github-profile:end -->";

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}\n${await response.text()}`);
  }

  return response.json();
}

async function githubRequest(path) {
  return requestJson(`${githubApiBase}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "profile-readme-updater",
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });
}

async function fetchAllRepos() {
  const repos = [];

  for (let page = 1; page <= 10; page += 1) {
    const pageRepos = await githubRequest(
      `/users/${encodeURIComponent(username)}/repos?per_page=100&page=${page}&sort=updated`,
    );

    if (!Array.isArray(pageRepos) || pageRepos.length === 0) {
      break;
    }

    repos.push(...pageRepos);
  }

  return repos;
}

function getRepoScore(repo) {
  const pushedAt = repo.pushed_at ? new Date(repo.pushed_at).getTime() : 0;
  const ageDays = pushedAt ? (Date.now() - pushedAt) / (1000 * 60 * 60 * 24) : 9999;
  const freshness = Math.max(0, 365 - ageDays) / 20;

  return (
    (repo.fork ? -1000 : 0) +
    (repo.archived ? -200 : 0) +
    (repo.description ? 20 : 0) +
    (repo.homepage ? 8 : 0) +
    Math.min(repo.size || 0, 5000) / 50 +
    (repo.stargazers_count || 0) * 5 +
    freshness
  );
}

function selectCandidateRepos(repos) {
  return repos
    .filter((repo) => !repo.fork && !repo.archived && repo.name !== username)
    .sort((left, right) => getRepoScore(right) - getRepoScore(left))
    .slice(0, 5);
}

async function getRepoFile(owner, repo, path) {
  try {
    const data = await githubRequest(`/repos/${owner}/${repo}/contents/${path}`);
    if (!data.content) {
      return null;
    }

    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

async function getRepoReadme(owner, repo) {
  try {
    const data = await githubRequest(`/repos/${owner}/${repo}/readme`);
    if (!data.content) {
      return null;
    }

    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

async function enrichRepo(repo) {
  const [languages, commits, readme, packageJson, clientPackageJson, serverPackageJson] = await Promise.all([
    githubRequest(`/repos/${repo.owner.login}/${repo.name}/languages`).catch(() => ({})),
    githubRequest(`/repos/${repo.owner.login}/${repo.name}/commits?per_page=3`).catch(() => []),
    getRepoReadme(repo.owner.login, repo.name),
    getRepoFile(repo.owner.login, repo.name, "package.json"),
    getRepoFile(repo.owner.login, repo.name, "client/package.json"),
    getRepoFile(repo.owner.login, repo.name, "server/package.json"),
  ]);

  return {
    name: repo.name,
    url: repo.html_url,
    homepage: repo.homepage,
    description: repo.description,
    language: repo.language,
    languages: Object.keys(languages),
    pushed_at: repo.pushed_at,
    recent_commits: commits
      .map((commit) => commit?.commit?.message?.split("\n")[0]?.trim())
      .filter(Boolean),
    readme_excerpt: readme ? readme.slice(0, 2000) : null,
    package_json: packageJson,
    client_package_json: clientPackageJson,
    server_package_json: serverPackageJson,
  };
}

function extractManagedBlock(readme) {
  const pattern = new RegExp(`${managedStart}[\\s\\S]*?${managedEnd}`);
  const match = readme.match(pattern);

  if (!match) {
    throw new Error(`Managed block markers are missing in ${readmePath}`);
  }

  return match[0];
}

function buildPrompt(profile, repos, currentBlock) {
  return `
Update only the managed block of a GitHub profile README for username "${username}".

Goal:
- keep token usage low by updating only the managed block
- do not rewrite the rest of the README
- keep the same structure and style as the current block unless data clearly requires a change

Hard rules:
- do not invent facts
- only use facts from the provided GitHub profile and repository data
- keep the markdown concise
- preserve the same section order:
  1. Featured Projects
  2. Focus Areas
  3. Currently Exploring
- keep project headings as markdown links when possible
- keep one short description and one stack line per project
- choose 3 to 5 projects
- return the full managed block including the start and end markers

Current managed block:
${currentBlock}

Public profile data:
${JSON.stringify(profile, null, 2)}

Repository data:
${JSON.stringify(repos, null, 2)}
`;
}

async function generateManagedBlock(profile, repos, currentBlock) {
  const response = await requestJson(`${openaiApiBase}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5",
      input: buildPrompt(profile, repos, currentBlock),
      text: {
        format: {
          type: "text",
        },
      },
    }),
  });

  const text =
    response.output_text?.trim() ||
    response.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text?.trim();

  if (!text) {
    throw new Error("OpenAI response did not contain text output");
  }

  if (!text.includes(managedStart) || !text.includes(managedEnd)) {
    throw new Error("Generated block is missing README markers");
  }

  return text;
}

async function writeManagedBlock(block) {
  const currentContent = await fs.readFile(readmePath, "utf8");
  const pattern = new RegExp(`${managedStart}[\\s\\S]*?${managedEnd}`);
  const nextContent = `${currentContent.replace(pattern, block).trimEnd()}\n`;

  if (nextContent === currentContent) {
    console.log("README.md unchanged");
    return;
  }

  await fs.writeFile(readmePath, nextContent, "utf8");
  console.log("README.md updated");
}

async function main() {
  if (!openaiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const currentReadme = await fs.readFile(readmePath, "utf8");
  const currentBlock = extractManagedBlock(currentReadme);
  const profile = await githubRequest(`/users/${encodeURIComponent(username)}`);
  const repos = await fetchAllRepos();
  const selectedRepos = selectCandidateRepos(repos);
  const enrichedRepos = await Promise.all(selectedRepos.map(enrichRepo));
  const nextBlock = await generateManagedBlock(
    {
      login: profile.login,
      name: profile.name,
      bio: profile.bio,
      blog: profile.blog,
      public_repos: profile.public_repos,
      created_at: profile.created_at,
    },
    enrichedRepos,
    currentBlock,
  );

  await writeManagedBlock(nextBlock);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
