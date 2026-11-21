/**
 * Hermetic tests for scripts/ship-deploy using PATH shims for docker, helm,
 * and kubectl against a throwaway Git repo.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const REAL_SHIP_DEPLOY = fs.readFileSync(path.join(repoRoot, "scripts", "ship-deploy"));

const WEB_DIGEST = `sha256:${"a".repeat(64)}`;
const WORKER_DIGEST = `sha256:${"b".repeat(64)}`;

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function makeFixture({ podWebDigest = WEB_DIGEST, podWorkerDigest = WORKER_DIGEST, podReady = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-ship-deploy-"));
  tempDirs.push(root);

  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const logFile = path.join(root, "calls.log");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "deploy", "docker"), { recursive: true });
  fs.mkdirSync(path.join(repo, "deploy", "helm", "companion"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".private", "deploy"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  fs.writeFileSync(path.join(repo, ".gitignore"), "/.private/\n");
  fs.writeFileSync(path.join(repo, "scripts", "ship-deploy"), REAL_SHIP_DEPLOY, { mode: 0o755 });
  fs.writeFileSync(path.join(repo, "deploy", "docker", "Dockerfile.web"), "FROM scratch\n");
  fs.writeFileSync(path.join(repo, "deploy", "docker", "Dockerfile.worker"), "FROM scratch\n");
  fs.writeFileSync(path.join(repo, "deploy", "helm", "companion", "Chart.yaml"), "apiVersion: v2\nname: companion\nversion: 0.1.0\n");

  fs.writeFileSync(
    path.join(repo, ".private", "deploy", "non-production-values.yaml"),
    [
      "web:",
      "  image:",
      "    repository: localhost:5104/companion/web",
      "worker:",
      "  image:",
      "    repository: localhost:5104/companion/worker",
      "",
    ].join("\n"),
  );

  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "chore: fixture"]);
  const sha = git(repo, ["rev-parse", "HEAD"]);

  // Shim docker
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\\n' "$*" >> "${logFile}"
case "$1" in
  build|push) exit 0 ;;
  inspect)
    if [[ "$2" == *"/web:"* ]]; then
      printf '["localhost:5104/companion/web@${WEB_DIGEST}"]\\n'
    else
      printf '["localhost:5104/companion/worker@${WORKER_DIGEST}"]\\n'
    fi
    ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );

  // Shim helm
  fs.writeFileSync(
    path.join(bin, "helm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'helm %s\\n' "$*" >> "${logFile}"
`,
    { mode: 0o755 },
  );

  // Shim kubectl
  const podsJson = JSON.stringify({
    items: [
      {
        metadata: { name: "companion-web-0", labels: { "app.kubernetes.io/name": "web" } },
        status: {
          containerStatuses: [
            { ready: podReady, imageID: `docker-pullable://localhost:5104/companion/web@${podWebDigest}` },
          ],
        },
      },
      {
        metadata: { name: "companion-worker-0", labels: { "app.kubernetes.io/name": "worker" } },
        status: {
          containerStatuses: [
            { ready: podReady, imageID: `docker-pullable://localhost:5104/companion/worker@${podWorkerDigest}` },
          ],
        },
      },
    ],
  });
  fs.writeFileSync(path.join(root, "pods.json"), podsJson);
  fs.writeFileSync(
    path.join(bin, "kubectl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'kubectl %s\\n' "$*" >> "${logFile}"
cat "${path.join(root, "pods.json")}"
`,
    { mode: 0o755 },
  );

  const run = (args) =>
    spawnSync(path.join(repo, "scripts", "ship-deploy"), args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

  return { repo, sha, logFile, run };
}

describe("scripts/ship-deploy", () => {
  it("builds from git archive, pushes, deploys digest-pinned chart, verifies pods, and prints SHIP_DEPLOYED_SHA", () => {
    const { sha, logFile, run } = makeFixture();
    const res = run([sha]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), `SHIP_DEPLOYED_SHA=${sha}`);

    const calls = fs.readFileSync(logFile, "utf8");
    assert.match(calls, new RegExp(`docker build .* -t localhost:5104/companion/web:${sha}`));
    assert.match(calls, new RegExp(`docker build .* -t localhost:5104/companion/worker:${sha}`));
    assert.match(calls, new RegExp(`docker push localhost:5104/companion/web:${sha}`));
    assert.match(calls, new RegExp(`docker push localhost:5104/companion/worker:${sha}`));
    assert.match(
      calls,
      new RegExp(
        `helm upgrade --install companion .* --namespace companion-np -f \\.private/deploy/non-production-values\\.yaml --set web\\.image\\.tag=${sha} --set web\\.image\\.digest=${WEB_DIGEST} --set worker\\.image\\.tag=${sha} --set worker\\.image\\.digest=${WORKER_DIGEST} --wait`,
      ),
    );
  });

  it("rejects missing, malformed, or mismatched SHA arguments", () => {
    const { sha, run } = makeFixture();
    assert.notEqual(run([]).status, 0);
    assert.notEqual(run(["not-a-sha"]).status, 0);
    assert.notEqual(run([sha, "extra"]).status, 0);
    const otherSha = sha.startsWith("0") ? `1${sha.slice(1)}` : `0${sha.slice(1)}`;
    assert.notEqual(run([otherSha]).status, 0);
  });

  it("rejects a dirty working tree", () => {
    const { repo, sha, run } = makeFixture();
    fs.writeFileSync(path.join(repo, "untracked.txt"), "dirty\n");
    const res = run([sha]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /working tree must be clean/);
  });

  it("fails when Ready pods do not match the pushed digests", () => {
    const wrongDigest = `sha256:${"f".repeat(64)}`;
    const { sha, run } = makeFixture({ podWebDigest: wrongDigest });
    const res = run([sha]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /no Ready web pod running/);
  });
});
