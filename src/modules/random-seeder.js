const assert = require('assert');
const crypto = require('crypto');
const get = require('lodash.get');
const Joi = require('joi-strict');

module.exports = (opts) => {
  Joi.assert(opts, Joi.object().keys({
    seed: Joi.string(),
    reseed: Joi.boolean()
  }), 'Invalid Options Provided');
  let original = null;

  return {
    inject: () => {
      assert(original === null);

      original = crypto.randomBytes;
      const executionCounts = {};

      crypto.randomBytes = (size, cb) => {
        // randomization is seeded "per key"
        const stack = new Error().stack.split('\n');
        const subStack = stack.slice(stack.findIndex((e) => e.indexOf('/node_modules/') !== -1));
        const stackOrigin = get(subStack, [subStack.findIndex((e) => e.indexOf('/node_modules/') === -1) - 1], '');
        const originFile = get(stackOrigin.match(/^.*?\([^)]+?\/node_modules\/([^)]+):\d+:\d+\)$/), [1], '');
        const key = `${originFile}@${size}`;

        executionCounts[key] = opts.reseed === true ? null : (executionCounts[key] || 0) + 1;
        let result = crypto
          .createHash('sha256')
          .update(opts.seed)
          .update(key)
          .update(String(executionCounts[key]))
          .digest();
        while (result.length < size) {
          result = Buffer.concat([result, crypto.createHash('sha256').update(result).digest()]);
        }

        result = result.slice(0, size);
        return cb ? cb(null, result) : result;
      };
    },
    release: () => {
      assert(original !== null);
      crypto.randomBytes = original;
      original = null;
    },
    isInjected: () => original !== null
  };
};
