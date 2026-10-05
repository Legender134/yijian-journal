'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const base = path.resolve(__dirname, '..');
const version = require('../package.json').version;
for (const name of ['.test-data', 'test-results']) fs.mkdirSync(path.join(base, name), { recursive: true });
const executable = path.join(base, 'dist', `v${version}`, '逸剑手札-win32-x64', '逸剑手札.exe');
if (!fs.existsSync(executable)) throw Error('Package the current version first');
const release = JSON.parse(fs.readFileSync(path.join(path.dirname(executable), 'release-manifest.json')));
const reportFile = path.join(base, 'test-results', `packaged-regression-${version}.json`);
const previous = process.argv.includes('--retry-failed') ? JSON.parse(fs.readFileSync(reportFile)) : null;
if (
  previous &&
  (previous.version !== version ||
    (previous.archiveSha256 && previous.archiveSha256 !== release.archiveSha256))
)
  throw Error('Previous regression belongs to a different package');
const report = {
  version,
  archiveSha256: release.archiveSha256,
  startedAt: new Date().toISOString(),
  jobs: [],
};
function run(script) {
  return new Promise((resolve) => {
    const at = Date.now();
    const env = { ...process.env, YIJIAN_EXECUTABLE: executable };
    // Let each harness choose visibility. Animation-disabled screenshots need a painted window.
    delete env.YIJIAN_TEST_HIDDEN;
    const child = spawn(process.execPath, [script], {
      cwd: base,
      env,
      stdio: 'inherit',
    });
    child.once('error', (error) => resolve({ script, exitCode: -1, error: error.message }));
    child.once('exit', (exitCode, signal) =>
      resolve({ script, exitCode, signal, elapsedMs: Date.now() - at }),
    );
  });
}
(async () => {
  for (const script of require('./regression-jobs.cjs')) {
    const old = previous?.jobs.find((job) => job.script === script);
    if (old?.exitCode === 0) report.jobs.push({ ...old, reusedFrom: previous.startedAt });
    else {
      const result = await run(script);
      if (old)
        result.previousAttempts = [
          ...(old.previousAttempts || []),
          { exitCode: old.exitCode, elapsedMs: old.elapsedMs, run: previous.startedAt },
        ];
      report.jobs.push(result);
    }
  }
  report.passed = report.jobs.every((job) => job.exitCode === 0);
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log('Packaged regression', report.passed ? 'PASS' : 'FAIL', report.jobs.length, 'jobs');
  if (!report.passed) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
