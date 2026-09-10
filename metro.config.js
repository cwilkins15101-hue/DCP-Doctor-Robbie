const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const config = getDefaultConfig(__dirname);

// @azure/msal-browser (used for real Dragon Copilot / Entra sign-in on web)
// pulls in @azure/msal-common's `/browser` subpath, whose own package.json
// points at a file that doesn't exist in the published npm package (a real
// upstream packaging bug — the file actually lives under dist-browser/, not
// dist/). Metro's exports-map resolution doesn't work around it, so this
// redirects that one broken subpath directly to the file that's really there.
config.resolver.unstable_enablePackageExports = true;

const brokenMsalCommonBrowserPath = path.join(
  __dirname,
  'node_modules/@azure/msal-common/dist-browser/index-browser.mjs'
);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@azure/msal-common/browser' && fs.existsSync(brokenMsalCommonBrowserPath)) {
    return { type: 'sourceFile', filePath: brokenMsalCommonBrowserPath };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
