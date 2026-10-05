'use strict';
// Process-exit fault injection against synthetic files only. This checks process
// interruption, not physical power-loss behavior of the disk/controller.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Saves, sha } = require('../src/core/saves.cjs');
const base = path.resolve(__dirname, '..');

if (process.argv[2] === '--child') {
  const [folder, snapshot, pointText, moment] = process.argv.slice(3);
  const fixtureRoot = path.resolve(folder);
  if (!fixtureRoot.startsWith(path.join(base, '.test-data', 'crash-boundaries-')))
    throw Error('Non-test target refused');
  const saves = new Saves(path.join(fixtureRoot, 'backups'));
  const point = Number(pointText),
    operations = [];
  for (const method of [
    'mkdirSync',
    'writeFileSync',
    'fsyncSync',
    'copyFileSync',
    'renameSync',
    'utimesSync',
    'unlinkSync',
  ]) {
    const original = fs[method];
    fs[method] = function (...args) {
      const index = operations.length + 1;
      operations.push({
        method,
        file: typeof args[0] === 'string' ? path.relative(fixtureRoot, args[0]) : 'open descriptor',
      });
      if (index === point && moment === 'before') process.exit(71);
      const value = original.apply(this, args);
      if (index === point && moment === 'after') process.exit(71);
      return value;
    };
  }
  saves.restore(snapshot, path.join(fixtureRoot, 'SaveGames'));
  console.log(JSON.stringify(operations));
} else {
  const suite = fs.mkdtempSync(path.join(base, '.test-data', 'crash-boundaries-'));
  const report = {
    startedAt: new Date().toISOString(),
    suite,
    checks: [],
    scope: 'synthetic process-exit recovery',
  };
  const values = (source) =>
    Object.fromEntries(
      fs
        .readdirSync(source)
        .filter((n) => !n.startsWith('.yijian-'))
        .map((n) => [n, sha(fs.readFileSync(path.join(source, n)))]),
    );
  function fixture(label) {
    const folder = path.join(suite, label),
      source = path.join(folder, 'SaveGames');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, '1.sav'), 'old first slot');
    fs.writeFileSync(path.join(source, '2.sav'), 'old second slot');
    const saves = new Saves(path.join(folder, 'backups')),
      snapshot = saves.capture(source, 'Synthetic old snapshot');
    const restored = values(source);
    fs.writeFileSync(path.join(source, '1.sav'), 'new first slot');
    fs.unlinkSync(path.join(source, '2.sav'));
    fs.writeFileSync(path.join(source, '9.sav'), 'unrelated new slot');
    restored['9.sav'] = sha(Buffer.from('unrelated new slot'));
    return { folder, source, saves, snapshot, before: values(source), restored };
  }
  function child(f, point, moment) {
    const result = spawnSync(
      process.execPath,
      [__filename, '--child', f.folder, f.snapshot.id, String(point), moment],
      { encoding: 'utf8', timeout: 15000, windowsHide: true },
    );
    if (result.error) throw result.error;
    return result;
  }
  try {
    const baseline = fixture('baseline'),
      run = child(baseline, 0, 'none');
    assert.equal(run.status, 0, run.stderr);
    const operations = JSON.parse(run.stdout.trim());
    assert.deepEqual(values(baseline.source), baseline.restored);
    report.operations = operations;
    for (let point = 1; point <= operations.length; point++) {
      for (const moment of ['before', 'after']) {
        const f = fixture(`${point}-${moment}`),
          result = child(f, point, moment);
        assert.equal(result.status, 71, result.stderr || `Did not stop at ${point} ${moment}`);
        const reopened = new Saves(path.join(f.folder, 'backups'));
        const pending = reopened.pendingRestore();
        let outcome;
        if (pending) {
          assert.equal(pending.error, undefined, `${point} ${moment}: invalid pending operation`);
          reopened.recoverRestore();
          assert.deepEqual(
            values(f.source),
            f.before,
            `${point} ${moment}: rollback changed pre-restore contents`,
          );
          assert.equal(reopened.pendingRestore(), null);
          outcome = 'recovered prior state';
        } else {
          const operationFile = path.join(f.folder, 'backups', '.restore-operation.json');
          const complete =
            fs.existsSync(operationFile) && JSON.parse(fs.readFileSync(operationFile)).phase === 'complete';
          assert.deepEqual(
            values(f.source),
            complete ? f.restored : f.before,
            `${point} ${moment}: unexpected state`,
          );
          outcome = complete ? 'completed restore retained' : 'prior state untouched';
        }
        assert.deepEqual(
          reopened.verify(f.snapshot.id).manifest.files.map((x) => x.sha256),
          f.snapshot.files.map((x) => x.sha256),
        );
        report.checks.push({ point, moment, method: operations[point - 1].method, outcome });
      }
      if (point % 10 === 0)
        console.log(`Crash boundary ${point}/${operations.length} passed before and after.`);
    }
    report.passed = true;
    console.log(
      `Crash-boundary audit PASS: ${report.checks.length} interruptions across ${operations.length} filesystem operations`,
    );
  } catch (e) {
    report.passed = false;
    report.failure = e.message;
    console.error(e);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(base, 'test-results', 'crash-boundaries-report.json'),
      JSON.stringify(report, null, 2),
    );
  }
}
