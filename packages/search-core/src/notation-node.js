'use strict';
/**
 * The one notation helper that needs Node: contentHash() is sha1 over the
 * canonical form, as pipeline/python/lib/notation.content_hash computes it.
 * Kept out of index.js so the phone's bundle stays free of node: builtins.
 */
const crypto = require('node:crypto');
const { canonicalJson, stripDefaults } = require('./notation.js');

function contentHash(rec) {
  const core = {
    sections: stripDefaults(rec).sections === undefined ? null : stripDefaults(rec).sections,
    shabad_id: ((rec.shabad || {}).shabad_id === undefined ? null : rec.shabad.shabad_id),
    raag_used: (((rec.heading || {}).raag || {}).key === undefined ? null : rec.heading.raag.key),
    taal: (((rec.heading || {}).taal || {}).key === undefined ? null : rec.heading.taal.key),
  };
  return crypto.createHash('sha1').update(canonicalJson(core), 'utf8').digest('hex');
}

module.exports = { contentHash };
