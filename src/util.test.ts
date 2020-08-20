import * as github from "@actions/github";
import test from 'ava';
import * as fs from 'fs';
import * as os from "os";
import sinon from 'sinon';

import * as api from './api-client';
import {setupTests} from './testing-utils';
import * as util from './util';

setupTests(test);

test('getToolNames', t => {
  const input = fs.readFileSync(__dirname + '/../src/testdata/tool-names.sarif', 'utf8');
  const toolNames = util.getToolNames(input);
  t.deepEqual(toolNames, ["CodeQL command-line toolchain", "ESLint"]);
});

test('getMemoryFlag() should return the correct --ram flag', t => {

  const totalMem = Math.floor(os.totalmem() / (1024 * 1024));

  const tests = {
    "": `--ram=${totalMem - 256}`,
    "512": "--ram=512",
  };

  for (const [input, expectedFlag] of Object.entries(tests)) {

    process.env['INPUT_RAM'] = input;

    const flag = util.getMemoryFlag();
    t.deepEqual(flag, expectedFlag);
  }
});

test('getMemoryFlag() throws if the ram input is < 0 or NaN', t => {
  for (const input of ["-1", "hello!"]) {
    process.env['INPUT_RAM'] = input;
    t.throws(util.getMemoryFlag);
  }
});

test('getThreadsFlag() should return the correct --threads flag', t => {

  const numCpus = os.cpus().length;

  const tests = {
    "0": "--threads=0",
    "1": "--threads=1",
    [`${numCpus + 1}`]: `--threads=${numCpus}`,
    [`${-numCpus - 1}`]: `--threads=${-numCpus}`
  };

  for (const [input, expectedFlag] of Object.entries(tests)) {

    process.env['INPUT_THREADS'] = input;

    const flag = util.getThreadsFlag();
    t.deepEqual(flag, expectedFlag);
  }
});

test('getThreadsFlag() throws if the threads input is not an integer', t => {
  process.env['INPUT_THREADS'] = "hello!";
  t.throws(util.getThreadsFlag);
});

test('getRef() throws on the empty string', t => {
  process.env["GITHUB_REF"] = "";
  t.throws(util.getRef);
});

test('isLocalRun() runs correctly', t => {
  const origLocalRun = process.env.CODEQL_LOCAL_RUN;

  process.env.CODEQL_LOCAL_RUN = '';
  t.assert(!util.isLocalRun());

  process.env.CODEQL_LOCAL_RUN = 'false';
  t.assert(!util.isLocalRun());

  process.env.CODEQL_LOCAL_RUN = '0';
  t.assert(!util.isLocalRun());

  process.env.CODEQL_LOCAL_RUN = 'true';
  t.assert(util.isLocalRun());

  process.env.CODEQL_LOCAL_RUN = 'hucairz';
  t.assert(util.isLocalRun());

  process.env.CODEQL_LOCAL_RUN = origLocalRun;
});

test('prepareEnvironment() when a local run', t => {
  const origLocalRun = process.env.CODEQL_LOCAL_RUN;

  process.env.CODEQL_LOCAL_RUN = 'false';
  process.env.GITHUB_JOB = 'YYY';

  util.prepareLocalRunEnvironment();

  // unchanged
  t.deepEqual(process.env.GITHUB_JOB, 'YYY');

  process.env.CODEQL_LOCAL_RUN = 'true';

  util.prepareLocalRunEnvironment();

  // unchanged
  t.deepEqual(process.env.GITHUB_JOB, 'YYY');

  process.env.GITHUB_JOB = '';

  util.prepareLocalRunEnvironment();

  // updated
  t.deepEqual(process.env.GITHUB_JOB, 'UNKNOWN-JOB');

  process.env.CODEQL_LOCAL_RUN = origLocalRun;
});

test('getExtraOptionsEnvParam() succeeds on valid JSON with invalid options (for now)', t => {
  const origExtraOptions = process.env.CODEQL_ACTION_EXTRA_OPTIONS;

  const options = {foo: 42};

  process.env.CODEQL_ACTION_EXTRA_OPTIONS = JSON.stringify(options);

  t.deepEqual(util.getExtraOptionsEnvParam(), <any>options);

  process.env.CODEQL_ACTION_EXTRA_OPTIONS = origExtraOptions;
});


test('getExtraOptionsEnvParam() succeeds on valid options', t => {
  const origExtraOptions = process.env.CODEQL_ACTION_EXTRA_OPTIONS;

  const options = { database: { init: ["--debug"] } };
  process.env.CODEQL_ACTION_EXTRA_OPTIONS =
    JSON.stringify(options);

  t.deepEqual(util.getExtraOptionsEnvParam(), options);

  process.env.CODEQL_ACTION_EXTRA_OPTIONS = origExtraOptions;
});

test('getExtraOptionsEnvParam() fails on invalid JSON', t => {
  const origExtraOptions = process.env.CODEQL_ACTION_EXTRA_OPTIONS;

  process.env.CODEQL_ACTION_EXTRA_OPTIONS = "{{invalid-json}}";
  t.throws(util.getExtraOptionsEnvParam);

  process.env.CODEQL_ACTION_EXTRA_OPTIONS = origExtraOptions;
});
type GetContentsResponse = { content?: string; } | {}[];

function mockGetContents(content: GetContentsResponse, status: number, isDirectory = false): sinon.SinonStub<any, any> {
  // Passing an auth token is required, so we just use a dummy value
  let client = new github.GitHub('123');
  const response = {
    data: isDirectory ? [content] : content,
    status: status
  };

  const spyGetContents = sinon.stub(client.repos, "getContents").resolves(response as any);
  sinon.stub(api, "getApiClient").value(() => client);
  return spyGetContents;
}

test('getFileContentsUsingAPI() throws if the request does not succeed', async t => {
  const spyGetContents = mockGetContents({}, 400);
  try {
    await util.getFileContentsUsingAPI('github', 'codeql-action', 'non-existing-file', 'main');
    throw new Error('initConfig did not throw error');
  } catch (err) {
    t.assert(spyGetContents.called);
    t.deepEqual(err, new Error(util.fileDownloadError('github/codeql-action/non-existing-file@main')));
  }
});

test('getFileContentsUsingAPI() throws if the requested file is a directory', async t => {
  const inputFileContents = `content content content`;
  const dummyResponse = {
    content: Buffer.from(inputFileContents).toString("base64"),
  };
  const spyGetContents = mockGetContents(dummyResponse, 200, true);
  try {
    await util.getFileContentsUsingAPI('github', 'codeql-action', 'non-existing-file', 'main');
    throw new Error('initConfig did not throw error');
  } catch (err) {
    t.assert(spyGetContents.called);
    t.deepEqual(err, new Error(util.fileIsADirectoryError('github/codeql-action/non-existing-file@main')));
  }
});

test('getFileContentsUsingAPI() returns the right content', async t => {
  const inputFileContents = `content content content`;
  const dummyResponse = {
    content: Buffer.from(inputFileContents).toString("base64"),
  };
  const spyGetContents = mockGetContents(dummyResponse, 200);
  const content = await util.getFileContentsUsingAPI('github', 'codeql-action', 'non-existing-file', 'main');

  t.deepEqual(content, inputFileContents);
  t.assert(spyGetContents.called);
});
