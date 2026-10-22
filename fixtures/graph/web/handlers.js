function Store() {}

/** Look a key up. */
Store.prototype.get = function (key) {
  return this.has(key);
};

Store.prototype.has = function has(key) {
  var found = key !== undefined;
  return found;
};

exports.list = function (req, res) {
  var page = 1;
  return res.render(page);
};

exports.Store = Store;
