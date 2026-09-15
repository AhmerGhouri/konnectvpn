const util = require('util');

// Node 21 compatibility polyfill: util.styleText in Node 21 only supports a single string format,
// whereas Metro v0.87+ passes format arrays like ['inverse', 'yellow', 'bold'] (supported in Node 22+).
if (typeof util.styleText === 'function') {
  const origStyleText = util.styleText.bind(util);
  util.styleText = (format, text) => {
    if (Array.isArray(format)) {
      let result = text;
      for (const f of format) {
        try {
          result = origStyleText(f, result);
        } catch {
          // ignore unsupported format tokens
        }
      }
      return result;
    }
    return origStyleText(format, text);
  };
}

const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
