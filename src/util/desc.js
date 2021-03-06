const assert = require('assert');
const path = require('path');
const fs = require('smart-fs');
const callsites = require('callsites');
const get = require('lodash.get');
const minimist = require('minimist');
const tmp = require('tmp');
const Joi = require('joi-strict');
const RequestRecorder = require('../modules/request-recorder');
const EnvManager = require('../modules/env-manager');
const TimeKeeper = require('../modules/time-keeper');
const LogRecorder = require('../modules/log-recorder');
const RandomSeeder = require('../modules/random-seeder');
const { getParents, genCassetteName } = require('./mocha-test');

const mocha = {
  it,
  specify,
  describe,
  context,
  before,
  after,
  beforeEach,
  afterEach
};

const desc = (suiteName, optsOrTests, testsOrNull = null) => {
  const opts = testsOrNull === null ? {} : optsOrTests;
  const tests = testsOrNull === null ? optsOrTests : testsOrNull;

  const testFile = path.resolve(callsites()[1].getFileName());
  const resolve = (name) => path.join(
    path.dirname(testFile),
    name.replace(/\$FILENAME/g, path.basename(testFile))
  );

  Joi.assert(opts, Joi.object().keys({
    useTmpDir: Joi.boolean().optional(),
    useNock: Joi.boolean().optional(),
    nockFolder: Joi.string().optional(),
    fixtureFolder: Joi.string().optional(),
    envVarsFile: Joi.string().optional(),
    envVars: Joi.object().optional().unknown(true).pattern(Joi.string(), Joi.string()),
    timestamp: Joi.number().optional().min(0),
    record: Joi.any().optional(),
    cryptoSeed: Joi.string().optional(),
    timeout: Joi.number().optional().min(0)
  }), 'Bad Options Provided');
  const useTmpDir = get(opts, 'useTmpDir', false);
  const useNock = get(opts, 'useNock', false);
  const nockFolder = resolve(get(opts, 'nockFolder', '$FILENAME__cassettes'));
  const fixtureFolder = resolve(get(opts, 'fixtureFolder', '$FILENAME__fixtures'));
  const envVarsFile = resolve(get(opts, 'envVarsFile', '$FILENAME.env.yml'));
  const envVars = get(opts, 'envVars', null);
  const timestamp = get(opts, 'timestamp', null);
  const record = get(opts, 'record', false);
  const cryptoSeed = get(opts, 'cryptoSeed', null);
  const timeout = get(opts, 'timeout', null);
  const nockHeal = get(minimist(process.argv.slice(2)), 'nock-heal', false);

  let dir = null;
  let requestRecorder = null;
  let envManagerFile = null;
  let envManagerDesc = null;
  let timeKeeper = null;
  let logRecorder = null;
  let randomSeeder = null;

  const getArgs = () => ({
    capture: async (fn) => {
      try {
        await fn();
      } catch (e) {
        return e;
      }
      throw new assert.AssertionError({ message: 'expected [Function] to throw an error' });
    },
    fixture: (name) => {
      const filepath = fs.guessFile(path.join(fixtureFolder, name));
      if (filepath === null) {
        throw new assert.AssertionError({ message: `fixture "${name}" not found or ambiguous` });
      }
      return fs.smartRead(filepath);
    },
    ...(dir === null ? {} : { dir }),
    ...(logRecorder === null ? {} : {
      recorder: {
        verbose: logRecorder.verbose,
        get: logRecorder.get,
        reset: logRecorder.reset
      }
    })
  });
  let beforeCb = () => {};
  let afterCb = () => {};
  let beforeEachCb = () => {};
  let afterEachCb = () => {};

  // eslint-disable-next-line func-names
  mocha.describe(suiteName, function () {
    return (async () => {
      if (timeout !== null) {
        this.timeout(timeout);
      }

      // eslint-disable-next-line func-names
      mocha.before(function () {
        return (async () => {
          if (getParents(this.test).length === 3 && fs.existsSync(envVarsFile)) {
            envManagerFile = EnvManager({ envVars: fs.smartRead(envVarsFile), allowOverwrite: false });
            envManagerFile.apply();
          }
          if (envVars !== null) {
            envManagerDesc = EnvManager({ envVars, allowOverwrite: false });
            envManagerDesc.apply();
          }
          if (timestamp !== null) {
            timeKeeper = TimeKeeper({ unix: timestamp });
            timeKeeper.inject();
          }
          if (cryptoSeed !== null) {
            randomSeeder = RandomSeeder({ seed: cryptoSeed, reseed: false });
            randomSeeder.inject();
          }
          if (useNock === true) {
            requestRecorder = RequestRecorder({
              cassetteFolder: `${nockFolder}/`,
              stripHeaders: false,
              strict: true,
              heal: nockHeal
            });
          }
          await beforeCb.call(this);
        })();
      });

      // eslint-disable-next-line func-names
      mocha.after(function () {
        return (async () => {
          if (requestRecorder !== null) {
            requestRecorder.shutdown();
            requestRecorder = null;
          }
          if (randomSeeder !== null) {
            randomSeeder.release();
            randomSeeder = null;
          }
          if (timeKeeper !== null) {
            timeKeeper.release();
            timeKeeper = null;
          }
          if (envManagerDesc !== null) {
            envManagerDesc.unapply();
            envManagerDesc = null;
          }
          if (envManagerFile !== null) {
            envManagerFile.unapply();
            envManagerFile = null;
          }
          await afterCb.call(this);
        })();
      });

      // eslint-disable-next-line func-names
      mocha.beforeEach(function () {
        return (async () => {
          if (useTmpDir === true) {
            tmp.setGracefulCleanup();
            dir = tmp.dirSync({ keep: false, unsafeCleanup: true }).name;
          }
          if (useNock === true) {
            await requestRecorder.inject(genCassetteName(this.currentTest));
          }
          if (record !== false) {
            logRecorder = LogRecorder({
              verbose: process.argv.slice(2).includes('--verbose'),
              logger: record
            });
            logRecorder.inject();
          }
          await beforeEachCb.call(this, getArgs());
        })();
      });

      // eslint-disable-next-line func-names
      mocha.afterEach(function () {
        return (async () => {
          if (logRecorder !== null) {
            logRecorder.release();
            logRecorder = null;
          }
          if (requestRecorder !== null) {
            requestRecorder.release();
          }
          if (dir !== null) {
            dir = null;
          }
          await afterEachCb.call(this, getArgs());
        })();
      });

      const globalsPrev = Object.keys(mocha)
        .reduce((p, key) => Object.assign(p, { [key]: global[key] }));
      global.it = (testName, fn) => mocha.it(
        testName,
        fn.length === 0 || /^[^(=]*\({/.test(fn.toString())
          // eslint-disable-next-line func-names
          ? function () {
            return fn.call(this, getArgs());
          }
          // eslint-disable-next-line func-names
          : function (done) {
            return fn.call(this, done);
          }
      );
      global.specify = global.it;
      global.describe = desc;
      global.context = global.describe;
      global.before = (fn) => {
        beforeCb = fn;
      };
      global.after = (fn) => {
        afterCb = fn;
      };
      global.beforeEach = (fn) => {
        beforeEachCb = fn;
      };
      global.afterEach = (fn) => {
        afterEachCb = fn;
      };
      await tests.call(this);
      Object.entries(globalsPrev).forEach(([k, v]) => {
        global[k] = v;
      });
    })();
  });
};
module.exports = desc;
