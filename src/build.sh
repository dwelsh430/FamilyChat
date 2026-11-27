# Rebuilds ../chat/index.html from app.js + template.html (bundles the Trystero library inline).
# Usage: npm install && bash build.sh
set -e
cd "$(dirname "$0")"
npx esbuild app.js --bundle --format=esm --minify --target=es2020 --legal-comments=inline --outfile=bundle.js --log-level=warning
python3 -c "
t=open('template.html').read(); b=open('bundle.js').read().replace('</script','<\\\\/script')
open('../chat/index.html','w').write(t.replace('/*__BUNDLE__*/',b))"
rm bundle.js
