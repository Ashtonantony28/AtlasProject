const handlers = require('./handlers');

function notFound() {}

function register(router) {
  router.get('/users', handlers.list);
  router.get('/store', [handlers.Store, notFound]);
  return { fallback: notFound, register };
}

module.exports = { register };
