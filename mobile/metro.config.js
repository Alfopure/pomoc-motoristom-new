const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// The web and mobile case filters share these pure contracts and labels.
config.watchFolders = [
  ...config.watchFolders,
  path.resolve(__dirname, '../src/lib'),
  path.resolve(__dirname, '../src/domain'),
];

module.exports = config;
