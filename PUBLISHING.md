# Publishing Agent Eye to a Marketplace

Two marketplaces cover every editor:

- **Visual Studio Marketplace** — VS Code, VS Code Insiders, and (via fallback)
  most forks. Published with [`vsce`](https://github.com/microsoft/vscode-vsce).
- **Open VSX** — Cursor, VSCodium, Gitpod, Windsurf, and other non-Microsoft
  builds that can't use the VS Code Marketplace. Published with
  [`ovsx`](https://github.com/eclipse/openvsx).

Publish to both so anyone can one-click install.

---

## Before you start

1. **Pick a publisher id** and set it in
   [`packages/vscode-extension/package.json`](packages/vscode-extension/package.json)
   — the `publisher` field must equal the id you create below (currently
   `agent-eye`). It becomes part of the extension URL and can't be changed later.
2. **Add the required metadata** (the Marketplace rejects extensions missing
   these): a `repository` URL (present), an `icon` (128×128 PNG, add
   `"icon": "media/icon.png"` to `package.json`), a good `README.md` (shown on the
   listing), and a `LICENSE` (present). Bump `version` for every publish.

---

## A. Visual Studio Marketplace (`vsce`)

Azure DevOps and the Marketplace are separate systems. Do these in order.

### 1. Create a publisher

Go to **https://marketplace.visualstudio.com/manage**, sign in with a Microsoft
account, and click **Create publisher**. Set:
- **ID** — permanent, used in URLs (e.g. `agent-eye`). Must match `package.json`.
- **Name** — display name.

### 2. Create a Personal Access Token (PAT)

1. Go to **https://dev.azure.com** and create/sign in to an organization.
2. Top-right **User settings** → **Personal access tokens** → **New Token**.
3. Set:
   - **Organization**: **All accessible organizations** (easy mistake to miss).
   - **Expiration**: your choice.
   - **Scopes**: **Custom defined** → **Marketplace** → **Manage**
     (or **Full access** if unsure).
4. **Copy the token now** — you cannot see it again.

> Note: Azure DevOps is retiring long-lived global PATs on **2026-12-01**; rotate
> tokens / use the current auth flow accordingly.

### 3. Log in and publish

```bash
npm i -g @vscode/vsce

cd packages/vscode-extension
npm run build                       # produce dist/

vsce login <your-publisher-id>      # paste the PAT when prompted
vsce publish --no-dependencies      # packages + uploads in one step
# (or bump + publish: vsce publish minor --no-dependencies)
```

Alternatively, **upload manually**: `vsce package --no-dependencies` to get the
`.vsix`, then drag it into **+ New extension → Visual Studio Code** on the
[manage page](https://marketplace.visualstudio.com/manage).

Your extension appears at
`https://marketplace.visualstudio.com/items?itemName=<publisher>.agent-eye` within
a few minutes and installs via **Extensions: Install** or
`code --install-extension <publisher>.agent-eye`.

---

## B. Open VSX (`ovsx`) — for Cursor / VSCodium / Windsurf

1. Sign in at **https://open-vsx.org** with GitHub, then
   **Settings → Access Tokens → Generate New Token**. Copy it.
2. Agree to the publisher agreement (once), and create your namespace:

```bash
npm i -g ovsx

# namespace must equal your package.json "publisher"
ovsx create-namespace <your-publisher-id> -p <open-vsx-token>

cd packages/vscode-extension
ovsx publish --no-dependencies -p <open-vsx-token>
# or publish an already-built file:  ovsx publish agent-eye-0.1.0.vsix -p <token>
```

Installs in Cursor/VSCodium via their Extensions view, or
`ovsx get <publisher>.agent-eye`.

---

## C. Automate with CI (optional)

Store `VSCE_PAT` and `OVSX_PAT` as repository secrets and publish on tag:

```yaml
# .github/workflows/publish.yml
name: publish
on:
  push:
    tags: ["v*"]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci && npm run build
      - working-directory: packages/vscode-extension
        run: |
          npx @vscode/vsce publish --no-dependencies -p ${{ secrets.VSCE_PAT }}
          npx ovsx publish --no-dependencies -p ${{ secrets.OVSX_PAT }}
```

---

## Checklist

- [ ] `publisher` in `package.json` matches your created publisher id (both marketplaces)
- [ ] `version` bumped
- [ ] `icon` (128×128 PNG), `repository`, `README.md`, `LICENSE` present
- [ ] `.vscodeignore` excludes source/maps (keeps the `.vsix` small)
- [ ] `vsce publish` (VS Code Marketplace) **and** `ovsx publish` (Open VSX)
- [ ] Verify the listing installs cleanly in a fresh editor
