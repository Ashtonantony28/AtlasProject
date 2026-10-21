module.exports = {
  tidy() {
    return 1;
  },
  neat: function () {
    return this.tidy();
  },
};
