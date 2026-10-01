'use strict';
/**
 * The same library, plus the parts that need Node.
 *
 * index.js is what a phone imports and is free of node: builtins, because Metro
 * bundles statically and one such require anywhere in its graph would break the
 * whole package. A server has no such constraint, so it imports this instead and
 * gets the SQLite adapter and the filesystem reader alongside everything else.
 */
module.exports = {
  ...require('./index.js'),
  ...require('./io-node.js'),
  ...require('./notation-node.js'),
  openNodeAdapter: require('./adapter-node.js').openNodeAdapter,
};
