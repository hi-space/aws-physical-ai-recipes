# Training deck diagrams

Korean-labelled variants of the two AWS topology diagrams in
[../../architecture.md](../../architecture.md). The English versions
there are the reference; these exist because the deck audience is Korean and the
slides need node labels they can read without translation.

The rendered SVG is inlined into `../osmo-infra-training.html` (as
`<svg id="awstop1">` / `<svg id="awstop2">`) so the deck stays a single offline
file with no CDN dependency. Regenerate after editing a `.mmd`:

```bash
npx -y @mermaid-js/mermaid-cli@10 \
  -i awstop1-ko.mmd -o /tmp/ko1.svg \
  -c mermaid-config.json -p puppeteer.json -b transparent
```

Then replace the matching `<svg id="awstopN"> … </svg>` block in the deck,
rewriting mermaid's `id="my-svg"` to `awstopN` (it scopes its `<style>` and
marker ids by that id, so two diagrams sharing `my-svg` would collide) and
dropping the `width` attribute so the `viewBox` alone drives scaling.

Rendering needs a headless Chromium with these shared libraries present:

```bash
sudo dnf install -y atk at-spi2-atk cups-libs libdrm libXcomposite libXdamage \
  libXfixes libXrandr libgbm alsa-lib pango nss libxkbcommon libxkbcommon-x11 \
  google-noto-sans-cjk-fonts
```

Without `google-noto-sans-cjk-fonts` the Korean labels render as blank space and
the layout silently shrinks — check a PNG render, not just the SVG.
