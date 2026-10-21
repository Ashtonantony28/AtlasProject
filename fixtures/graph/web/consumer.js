const legacy = require('./legacy.cjs');

function useLegacy() {
  return legacy.tidy();
}

module.exports = useLegacy;
