# Upstreaming the plane-offload patches

The seven patches in [`scripts/patches/`](../scripts/patches/) are not tvbox
quirks. Two are plain wlroots bugs that affect every compositor, one is a fix
upstream already knows it needs, one fills a gap in the backend API, and the
rest are the feature this box needed. This file is what to file, where, and in what order.

**Everything below has to be done by hand in a browser.** Two things block
automation on `gitlab.freedesktop.org`:

- **Creating an issue or posting a comment trips the spam filter** for a new
  account and demands a reCAPTCHA (`HTTP 409 needs_captcha_response`). Solving
  it once in the browser is enough; the account stops being treated as new.
- **Forking is refused** — _"Limit reached. You cannot create projects in your
  personal namespace"_. freedesktop gates project creation for new accounts.
  Ask for it in `#freedesktop` on OFTC, or open a request at
  <https://gitlab.freedesktop.org/freedesktop/freedesktop/-/issues>. Without a
  fork there is nowhere to push a branch, so no merge request.

Do the captcha first: with issues working, the two bug reports can go up
immediately and the merge requests can follow whenever the fork lands.

## What is already upstream — read before filing

Do not open a new tracking issue for the feature itself. It exists, it is about
this exact hardware, and it has a patch series:

| Where                                                                         | What                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [issue #3794](https://gitlab.freedesktop.org/wlroots/wlroots/-/issues/3794)   | "Use libliftoff for compositing client windows", opened 2024-01-09 by david.turner (Raspberry Pi): capable hardware compositor, weak GPU, wants wlr_scene to hand surfaces to libliftoff. emersion called it "a very desirable feature". |
| [!4348](https://gitlab.freedesktop.org/wlroots/wlroots/-/merge_requests/4348) | "wlr_scene: Implement Output Layers" — the live attempt, based on !4253 and !4015. Open since 2023-09, last touched 2024-02.                                                                                                             |

!4348's own description already says the thing we measured independently:

> Note that with this MR, libliftoff will likely deadline before it finds a
> layer to offload, resulting in this MR to seemingly do nothing. Increasing
> the libliftoff deadline from 1ms to 5ms will help with testing.

So the deadline is known upstream and still unfixed. Our patch is the fix, and
5 ms is the value both sides arrived at.

## Issue 1 — the YCbCr opacity bug

Nothing exists for this. Searched: `pixel_format_has_alpha`, `P030 opaque`,
`opaque yuv`, `nv12 opaque` — no hits.

**Title**

```
pixel_format_has_alpha() treats most YCbCr formats as translucent (P030 and friends)
```

**Description**

````markdown
`pixel_format_has_alpha()` answers from `opaque_pixel_formats[]` and returns true
for anything absent from it. `pixel_format_is_ycbcr()` knows 58 YCbCr formats;
four of them are on that list (YVYU, VYUY, NV12, P010).

So a 10-bit 4:2:0 video buffer is reported as possibly-translucent while the
8-bit one beside it is not. `DRM_FORMAT_P030` is the concrete case: it is what a
Raspberry Pi 5 HEVC decoder produces, and what mpv's `dmabuf-wayland` output
passes through untouched.

### Consequences

`wlr_buffer_is_opaque()` (`types/buffer/buffer.c:133`) returns false, and from
there:

- wlr_scene occlusion culling never discards what a fullscreen video covers, so
  the compositor keeps drawing surfaces nobody can see;
- `scene_entry_render()` cannot select `WLR_RENDER_BLEND_MODE_NONE` for it;
- anything gated on opacity refuses the buffer, including the plane-offload work
  in !4348.

### Reproducing

Post a P030 dmabuf (or YUYV, or any NV*/P* variant other than NV12 and P010) as
a fullscreen surface with another surface behind it: the surface behind is still
rendered. The same content as NV12 is culled.

### Suggested fix

Listing the other 47 formats would re-arm the same drift the next time one is
added to `pixel_format_is_ycbcr()`. Stating the invariant the other way round is
smaller and self-maintaining: of the YCbCr formats wlroots knows, six carry
alpha — AYUV, Y0L0, Y0L2, Y410, Y412, Y416 — and the rest do not.

```c
static bool ycbcr_format_has_alpha(uint32_t fmt) {
	switch (fmt) {
	case DRM_FORMAT_AYUV:
	case DRM_FORMAT_Y0L0:
	case DRM_FORMAT_Y0L2:
	case DRM_FORMAT_Y410:
	case DRM_FORMAT_Y412:
	case DRM_FORMAT_Y416:
		return true;
	default:
		return false;
	}
}
```

called from `pixel_format_has_alpha()` before the list lookup, with the four
YCbCr entries removed from `opaque_pixel_formats[]` so there is one source of
truth. No libdrm bump: every FourCC involved is already referenced by
`pixel_format_is_ycbcr()` in the same file.

I have a patch in that shape and will open an MR against this issue.

Found while measuring 4K playback on a Raspberry Pi 5 (vc4 + v3d, labwc 0.20.0,
wlroots 0.20.2).
````

## Issue 2 — image descriptions are refused on the libliftoff interface

Nothing exists for this either. Searched: `libliftoff image description`,
`liftoff colorspace`, `hdr_output_metadata liftoff`, `max bpc liftoff`.

**Title**

```
Image descriptions are refused on the libliftoff interface, which stops the output entirely
```

**Description**

````markdown
`drm_connector_prepare()` refuses any state carrying an image description unless
the backend is on the atomic interface, and spells that as:

```c
if ((state->committed & WLR_OUTPUT_STATE_IMAGE_DESCRIPTION) &&
        conn->backend->iface != &atomic_iface) {
    wlr_log(WLR_DEBUG, "Image descriptions are only supported by the atomic interface");
    return false;
}
```

There are three interfaces — legacy, atomic and liftoff — and libliftoff drives
the same atomic API. So the condition is true on the liftoff interface as well,
and the result is not a colour-management fallback but a dead output: **every
test and every commit carrying an image description is refused.** A compositor
that attaches one to each frame — labwc does — cannot present at all once
`WLR_DRM_FORCE_LIBLIFTOFF=1` is set.

The check was not wrong about the code, only about the reason: the liftoff
interface really never set `Colorspace`, `HDR_OUTPUT_METADATA` or `max bpc`. But
it already computes the first two — it shares `drm_atomic_connector_prepare()`,
and the metadata blob is managed by the shared apply/rollback — so it only had
to put them in the request, next to the `content_type` it already sets. `max bpc`
has to come with them: it is derived from the scanned-out format and clamped to
what the connector advertises, and left alone it keeps whatever the previous DRM
master set, so signalling BT2020/PQ without it means asking for HDR and possibly
transmitting at 8 bits, or attempting deep colour on a link that cannot carry it.
`pick_max_bpc()` needs exporting from `atomic.c` for that.

The guard should then be narrowed to `iface == &legacy_iface`, which is the one
with no atomic request to put any of this in.

### Reproducing

Run any wlroots compositor that sets an image description with
`WLR_DRM_FORCE_LIBLIFTOFF=1`. Nothing is presented; the log fills with
"Image descriptions are only supported by the atomic interface" at frame rate.

Found on a Raspberry Pi 5 (vc4), wlroots 0.20.2 + labwc 0.20.0. This is what made
the rest of the plane-offload work in !4348 unreachable there: the offload cannot
be evaluated at all while every commit is rejected first.

I have a patch and will open an MR against this issue.
````

## Comment to add to issue #3794

Post this on the existing issue rather than opening a third one. It ties our
measurements to the work already tracked there, and asks the question that
decides whether to send a competing MR.

```markdown
I have been running !4348's idea on the hardware this issue was opened about — a
Raspberry Pi 5, vc4 + v3d, labwc 0.20.0 on wlroots 0.20.2 — and got a 4K film
onto the primary plane with a fullscreen translucent UI on an overlay:
compositor GPU time 67% -> 0%, and 0 dropped / 0 delayed frames over the
measurement, where before it dropped ~17 frames a second.

Getting there turned up three defects independent of the scene work, and I think
two of them are why this looks like it "seemingly does nothing" for people who
try it:

1. **`pixel_format_has_alpha()` treats most YCbCr formats as translucent** — it
   answers from a list naming four of the 58 formats `pixel_format_is_ycbcr()`
   knows, and `P030` (what this hardware decodes 10-bit video into) is absent
   while `P010` and `NV12` are present. Every opacity-gated path then refuses the
   video buffer. This was the actual blocker for 4K here. Filed as #ISSUE1.
2. **Image descriptions are refused on the libliftoff interface**, which stops
   the output entirely for a compositor that attaches one per frame. Filed as
   #ISSUE2.
3. **The composition fallback is armed even when nothing needs it.** wlroots
   gives libliftoff the composition layer and the primary layer holding the same
   buffer at the same zpos; where the primary is the only plane at that level
   (vc4 pins its primary zpos to 0 and marks the property immutable) the two
   compete and the fallback wins, so the real content is composited even though
   the arrangement fits. Measured standalone against libliftoff with no
   compositor involved: a video layer and a UI layer land on a primary and an
   overlay with nothing composited, right up until the composition layer joins
   them, at which point the video gets no plane at all.

Also confirming the note in !4348's description from a second direction: the 1 ms
default deadline does expire before an allocation is found here
(`candidate planes: 0`), and 5 ms is enough. libliftoff caches the mapping and
only re-searches when the layer set changes, so that budget is not paid per
frame — though it is paid twice on a frame where an offload is offered and
refused.

I have patches for all of the above against 0.20.2, plus a narrower scene-side
variant of !4348 (one surface above one that is opaque over the whole output).
I would rather feed the useful parts into !4348 than open a competing MR —
@leoli, @Nefsen402: is that MR still live, and would the fixes above be welcome
as separate MRs in front of it?

One caveat I have not solved, and I think it is an API gap rather than an
implementation detail: `struct wlr_output_layer_state` has no wait timeline, so
an explicit-sync client's acquire point cannot be honoured for a buffer that goes
on a layer.
```

Replace `#ISSUE1` / `#ISSUE2` with the numbers the two issues get.

## Merge requests, once the fork exists

The patches are `git format-patch` output with their commit messages already
written, so `git am` them onto a branch per MR and push.

| Branch                 | Patch                                                                 | Links to                   | Standing                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ycbcr-opaque`         | `wlroots-0001-render-alpha-less-ycbcr-formats-are-opaque.patch`       | `Closes` issue 1           | Ready. Reviewed clean, no dependencies.                                                                                                    |
| `liftoff-colour-props` | `wlroots-0002-drm-colour-props-on-the-liftoff-interface.patch`        | `Closes` issue 2           | Ready. Must stay ONE commit — the guard narrowing without the property hunk turns a clean refusal into silently ignored colour management. |
| `liftoff-deadline`     | `wlroots-0004-drm-give-libliftoff-a-deadline-it-can-finish-in.patch`  | References #3794 and !4348 | Ready, and quote !4348's description in the MR: upstream documented the problem and never fixed it.                                        |
| —                      | `wlroots-0003` (scene offload) and `wlroots-0005` (composition layer) | #3794 / !4348              | **Hold.** Send the comment above first. These two only make sense together, and the scene half overlaps !4348 by design.                   |

`labwc-0001` went to <https://github.com/labwc/labwc> as an ordinary pull
request — **[labwc#3685](https://github.com/labwc/labwc/pull/3685)**, opened
2026-08-03, against `master` rather than the 0.20.0 tag (it applies cleanly to
both). It is independent of everything above and stands on its own: a failed
render-format probe leaving the format at the last candidate it tried is a bug
with or without layers.

## The regression that was open, and what it turned out to be

Found and fixed on 2026-08-03. Worth keeping, because the cause is not in
wlroots at all.

With the patched build, an output that was turned off could not be turned back
on:

```
[ERROR] [libliftoff] drmCrtcGetSequence: Invalid argument
[DEBUG] connector HDMI-A-1: liftoff_output_apply failed: Operation not permitted
```

`drmCrtcGetSequence` is not in upstream libliftoff 0.5.0. The Raspberry Pi OS
package is `0.5.0-1.1+rpt6`, maintained by David Turner — the same person who
opened #3794 — and its "allocation optimisation patches" budget the plane search
against the CRTC's vblank sequence. On a CRTC being switched off there is no
sequence to read, so the call fails and the whole apply returns EPERM.

It only happens when wlroots passes `liftoff_output_apply_options`, which is
exactly what our deadline patch added. Measured both ways: with the patch,
`--off` succeeds and `--on` never does; without it, off/on is clean and there is
not one `drmCrtcGetSequence` line.

The fix is in `wlroots-0005`: pass the options only for a connector that is meant
to show something. A commit that disables an output has nothing to allocate, so
the default budget is fine for it. Verified: off/on works, the offload still
engages, 0 dropped frames at 2160p.

Worth mentioning to David Turner when the #3794 comment goes up — the RPi patch
is fine on its own, and it is wlroots asking for a deadline on a dying CRTC that
brings the two together badly.

## What our own review found that upstream will ask about

Worth having ready rather than being told: the scene half still has open
questions that are why patches 0003 and 0005 are on hold.

- A backend can accept a commit carrying layers and display none of them, and
  there is no way to ask in advance. The idiomatic fix is a
  `wlr_backend.features.output_layers` bit next to the existing
  `features.timeline`, set from `iface == &liftoff_iface` on DRM and false on the
  nested backends.
- `wlr_output_layer_state` has no wait timeline (above), and no alpha, so only
  fully opaque unscaled surfaces can be offloaded.
- Screen capture is safe by accident: capture takes
  `wlr_output_lock_attach_render()`, which turns direct scan-out off, so the
  offload stands down while a recorder runs.
