const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const VERSION = "57.0.4";
const ORIGINAL_SHA256 = "72c670b538732977ef132759ce810c5719943ce6082195a58ad5a432d4ac1075";
const PATCHED_SHA256 = "00c07cddfab609e7dfc0fd5e8395f111569635f26d6666be5d489a3fe4777965";
const SOURCE_PATH = "android/src/main/java/expo/modules/securestore/SecureStoreModule.kt";
const hash = source => createHash("sha256").update(source).digest("hex");

function patchSecureStoreSource(source, version) {
  if (version !== VERSION) throw new Error("SecureStore disk guard: unsupported package version; review the native patch before upgrading.");
  const currentHash = hash(source);
  if (currentHash === PATCHED_SHA256) return source;
  if (currentHash !== ORIGINAL_SHA256) throw new Error("SecureStore disk guard: unexpected native source; refusing a partial or unreviewed patch.");
  const patched = source
    .replace('    Name("ExpoSecureStore")\n', '    Name("ExpoSecureStore")\n    Constant("pmDraftDiskCommitChecked") { 1 }\n')
    .replace("    return prefs.edit().putString(key, encryptedItemString).commit()", `    val success = prefs.edit().putString(key, encryptedItemString).commit()
    if (!success) {
      throw WriteException("Could not persist the encrypted item to SecureStore", key, keychainService)
    }
    return success`);
  if (hash(patched) !== PATCHED_SHA256) throw new Error("SecureStore disk guard: transformed source did not match the reviewed patch.");
  return patched;
}

function withDraftSecureStore(config) {
  return withDangerousMod(config, ["android", async mod => {
    // Config import/export and introspection must never mutate dependencies.
    if (mod.modRequest.introspect || mod.modRequest.platform !== "android") return mod;
    const packageFile = require.resolve("expo-secure-store/package.json", { paths: [mod.modRequest.projectRoot] });
    const { version } = JSON.parse(readFileSync(packageFile, "utf8"));
    const sourceFile = join(dirname(packageFile), SOURCE_PATH);
    const original = readFileSync(sourceFile, "utf8");
    const patched = patchSecureStoreSource(original, version);
    if (patched !== original) writeFileSync(sourceFile, patched);
    return mod;
  }]);
}

module.exports = withDraftSecureStore;
module.exports.patchSecureStoreSource = patchSecureStoreSource;
