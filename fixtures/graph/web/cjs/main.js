const app = require('./index');
const Model = require('./Model');

function main() {
  app();
  app.version();
  return new Model();
}

class Sub extends Model {
  run() {
    return this.save();
  }
}

module.exports = { main, Sub };
