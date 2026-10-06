# UltrawideStreamCrop

Vencord plugin for watching ultrawide streams (21:9, 32:9) on a 16:9 screen. Instead of a thin strip with black bars, the stream fills the player with its center 16:9.

- Drag to pan to the sides
- Scroll to zoom in, or out until the whole stream is visible
- Works in the call view and the pop-out player

## Install

This is a user plugin, so it needs Vencord built from source. The regular Vencord installer can't load it. You need git, Node.js and pnpm.

```sh
git clone https://github.com/Vendicated/Vencord
cd Vencord
git clone <this repo's URL> src/userplugins/ultrawideStreamCrop
pnpm install --frozen-lockfile
pnpm build
pnpm inject
```

Restart Discord and enable UltrawideStreamCrop in Settings → Vencord → Plugins.
