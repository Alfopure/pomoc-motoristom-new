const { withInfoPlist } = require("expo/config-plugins");

/** expo-task-manager declares background fetch in every app that installs it. This app
 * runs no fetch task (the pristavovač's position has the location mode), and App Review
 * accepts background modes only for their purpose (Guideline 2.5.4). */
function withNoBackgroundFetch(config) {
  return withInfoPlist(config, mod => {
    const modes = (mod.modResults.UIBackgroundModes ?? []).filter(mode => mode !== "fetch");
    if (modes.length) mod.modResults.UIBackgroundModes = modes;
    else delete mod.modResults.UIBackgroundModes;
    return mod;
  });
}

module.exports = withNoBackgroundFetch;
