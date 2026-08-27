# Vendored Admin Web UI assets

`tailwind.css`, `driver.css`, and `driver.iife.js` are vendored here
(committed to the repo) instead of loaded from `cdn.tailwindcss.com` /
`cdn.jsdelivr.net`.

**Why:** the Admin Web UI must render correctly on air-gapped or
no-outbound-internet deployments (e.g. an internal VMware VM with no proxy
to the public internet). Loading Tailwind/driver.js from a public CDN meant
the whole page silently rendered unstyled/broken in that environment.

## Regenerating `tailwind.css`

Only needed after adding new Tailwind utility classes to `login.html` /
`setup.html`. Uses the official standalone Tailwind CLI (no Node
build toolchain required):

```bash
curl -sSL -o /tmp/tailwindcss-cli \
  https://github.com/tailwindlabs/tailwindcss/releases/latest/download/tailwindcss-linux-x64
chmod +x /tmp/tailwindcss-cli
echo '@import "tailwindcss";' > /tmp/tailwind-input.css
/tmp/tailwindcss-cli \
  --input /tmp/tailwind-input.css \
  --output src/contexts/admin-ui/assets/vendor/tailwind.css \
  --content "src/contexts/admin-ui/assets/*.html" \
  --minify
```

## Regenerating `driver.css` / `driver.iife.js`

Only needed when bumping the driver.js version (currently pinned to
`1.3.1`, matching the version previously loaded from jsDelivr):

```bash
curl -sSL -o src/contexts/admin-ui/assets/vendor/driver.css \
  https://cdn.jsdelivr.net/npm/driver.js@1.3.1/dist/driver.css
curl -sSL -o src/contexts/admin-ui/assets/vendor/driver.iife.js \
  https://cdn.jsdelivr.net/npm/driver.js@1.3.1/dist/driver.js.iife.js
```

After regenerating either file, re-run the admin-ui smoke tests
(`bun test tests/smoke/admin-ui-boot.smoke.test.ts`) to confirm the page
still renders and the login flow still works.
