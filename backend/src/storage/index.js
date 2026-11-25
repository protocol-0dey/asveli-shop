'use strict';
const cfg = require('../config');
const { getSetting, setSetting } = require('../db');

let instance;
module.exports = function getStorage() {
  if (instance) return instance;
  if (cfg.storageDriver === 'drive') {
    const Drive = require('./drive');
    instance = Drive.fromCredentials(cfg.drive, { getSetting, setSetting });
  } else {
    const Local = require('./local');
    instance = new Local(cfg.dataDir);
  }
  return instance;
};
