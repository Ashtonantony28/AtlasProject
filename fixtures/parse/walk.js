'use strict';
const path = require('path');
const { join: j, resolve } = require('./paths');

module.exports = function createApp(opts) {
  return build(opts, path.join('a', 'b'));
};

exports.helper = function helper() {
  return require('./lazy').run();
};

module.exports.Model = class Model extends Base {
  save() {
    return this.db.write(j('x'));
  }
};

app.use(function middleware(req, res, next) {
  const done = () => next();
  res.on('finish', () => log(req.url));
  done();
});

module.exports.routes = {
  index: (req) => render(req),
  show(req) {
    return find(req.params.id);
  },
};

const el = <Widget onClick={() => go()} />;

function calls(a) {
  require('./inner');
  new require('./not-an-import');
  a?.b?.c();
  a['k']();
  return import('./dyn').then((m) => m.default.go());
}
