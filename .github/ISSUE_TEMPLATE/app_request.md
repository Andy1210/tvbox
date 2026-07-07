---
name: App request / submission
about: Propose a new app (or submit a manifest)
labels: app
---

**Which service?**

**What shape is it?** (see docs/app-manifest.md)

- [ ] Remote site (has a TV/leanback web UI at a URL)
- [ ] Static bundle (a web client that can be self-hosted + mpv playback)
- [ ] Needs a shell plugin (daemon/OAuth/custom routes)

**Manifest draft** (if you have one - validate with
`npx ajv-cli validate -s docs/app-manifest.schema.json -d app.json --spec=draft2020`):

```json

```
