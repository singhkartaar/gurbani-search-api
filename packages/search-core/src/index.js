'use strict';
/**
 * Everything that runs anywhere.
 *
 * The Node-only modules -- adapter-node.js (node:sqlite) and io-node.js
 * (node:fs) -- are deliberately NOT re-exported here. Metro bundles statically,
 * so a single require of a node: builtin anywhere in this graph would make the
 * whole package unbundleable for React Native, however lazily it was written.
 * A Node caller imports those two files directly; see index-node.js, which is
 * this barrel plus both of them.
 */
module.exports = {
  ...require('./lexical.js'),
  ...require('./semantic.js'),
  ...require('./retrieve.js'),
  ...require('./artifacts.js'),
  ...require('./vectors.js'),
  ...require('./stanza.js'),
  ...require('./registry.js'),
  ...require('./corpus.js'),
  keyboard: require('./keyboard.js'),
  gurmukhi: require('./gurmukhi.js'),
};
