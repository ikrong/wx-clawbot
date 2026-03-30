export NPM_CONFIG_REGISTRY=https://registry.npmjs.com
echo "$NPM_CONFIG_REGISTRY"
ver=$(npm info wx-clawbot version) 
npm version $ver --no-git-tag-version >/dev/null 2>&1
npm version patch --no-git-tag-version >/dev/null 2>&1
npm run build 
npm publish