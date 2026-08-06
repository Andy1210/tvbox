# Upstreaming the plane-offload patches

> The box does not run these any more. It has its own compositor
> ([tvbox-wc](https://github.com/Andy1210/tvbox-wc), built on Smithay), so labwc
> and wlroots are gone from the image. The patches are kept because the bugs are
> real and still upstream's: three of them affect every wlroots compositor,
> whatever this box ended up doing.

The eleven patches in [`upstream/patches/`](upstream/patches/) — nine against
wlroots, two against labwc — are not tvbox quirks. Three are plain wlroots bugs
that affect every compositor, one is a fix upstream already knows it needs, one
fills a gap in the backend API, and the rest are the feature this box needed. This
file is what to file, where, and in what order.

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

**Each bug report carries its own diff**, below, because a report a maintainer
cannot act on is half a report - and without a fork there is no merge request to
link to. When the fork lands, the same patches become the MRs in the table at the
end, and the issues get a link instead.

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

> **Filed as [issue 4112][i4112] and answered, and the answer changed our patch.**
> emersion rejected the invariant proposed below: stating it as "YCbCr formats are
> opaque unless they are one of the six that carry alpha" means a YUV format the
> kernel adds LATER, with alpha, reads as opaque and has its alpha stripped.
> `is_opaque` is only an optimisation, so an unknown format must read as
> translucent - a missed optimisation is the correct failure. `wlroots-0001` is
> therefore one line now: add `DRM_FORMAT_P030` to the existing allowlist, which
> is the format this hardware actually produces.
>
> He pointed at **[!5271][mr5271]** (generate the format tables from go-kdfs) as
> the general fix, and it does widen the opaque list from 4 YCbCr formats to about 20. **It does not close this issue as it stands**, measured against the MR's
> current diff on 2026-08-04: the generated `pixel_format_is_opaque()` lists 64
> formats and **P030 is not among them**, so `pixel_format_has_alpha(P030)` still
> answers true. **P010 is missing from it too**, and that one IS on master's
> hand-written list today, so the MR would turn it from opaque into
> possibly-translucent. The P0xx multi-plane 10-bit formats look like they are not
> coming through from the data source. Before dropping `wlroots-0001` after that
> MR lands, check the one thing that matters: does the merged tree answer true for
> `pixel_format_is_opaque(DRM_FORMAT_P030)`.

[i4112]: https://gitlab.freedesktop.org/wlroots/wlroots/-/issues/4112
[mr5271]: https://gitlab.freedesktop.org/wlroots/wlroots/-/merge_requests/5271

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

### The patch

Against 0.20.2. I cannot open a merge request yet - this account has no fork
rights on this instance - so the diff is here rather than behind a link.

```diff
diff --git a/render/pixel_format.c b/render/pixel_format.c
index c60dd9d..a740ef4 100644
--- a/render/pixel_format.c
+++ b/render/pixel_format.c
@@ -211,10 +211,6 @@ static const uint32_t opaque_pixel_formats[] = {
 	DRM_FORMAT_XBGR2101010,
 	DRM_FORMAT_XBGR16161616F,
 	DRM_FORMAT_XBGR16161616,
-	DRM_FORMAT_YVYU,
-	DRM_FORMAT_VYUY,
-	DRM_FORMAT_NV12,
-	DRM_FORMAT_P010,
 };

 static const size_t pixel_format_info_size =
@@ -299,7 +295,29 @@ bool pixel_format_info_check_stride(const struct wlr_pixel_format_info *fmt,
 	return true;
 }

+// The YCbCr formats that carry alpha. Stated as the exceptions rather than as a
+// list of the rest, so that a format added to pixel_format_is_ycbcr() cannot go
+// on being treated as translucent because a second list was not updated.
+static bool ycbcr_format_has_alpha(uint32_t fmt) {
+	switch (fmt) {
+	case DRM_FORMAT_AYUV:
+	case DRM_FORMAT_Y0L0:
+	case DRM_FORMAT_Y0L2:
+	case DRM_FORMAT_Y410:
+	case DRM_FORMAT_Y412:
+	case DRM_FORMAT_Y416:
+		return true;
+	default:
+		return false;
+	}
+}
+
+bool pixel_format_is_ycbcr(uint32_t format);
+
 bool pixel_format_has_alpha(uint32_t fmt) {
+	if (pixel_format_is_ycbcr(fmt)) {
+		return ycbcr_format_has_alpha(fmt);
+	}
 	for (size_t i = 0; i < opaque_pixel_formats_size; i++) {
 		if (fmt == opaque_pixel_formats[i]) {
 			return false;
```

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

### The patch

Against 0.20.2, and it has to stay one commit: the guard narrowing without the
property hunk turns a clean refusal into silently ignored colour management. I
cannot open a merge request yet - this account has no fork rights on this
instance - so the diff is here rather than behind a link.

```diff
diff --git a/backend/drm/atomic.c b/backend/drm/atomic.c
index faa535d..a33c9b0 100644
--- a/backend/drm/atomic.c
+++ b/backend/drm/atomic.c
@@ -274,7 +274,7 @@ static uint64_t max_bpc_for_format(uint32_t format) {
 	}
 }

-static uint64_t pick_max_bpc(struct wlr_drm_connector *conn, struct wlr_drm_fb *fb) {
+uint64_t drm_atomic_pick_max_bpc(struct wlr_drm_connector *conn, struct wlr_drm_fb *fb) {
 	uint32_t format = DRM_FORMAT_INVALID;
 	struct wlr_dmabuf_attributes attribs = {0};
 	if (wlr_buffer_get_dmabuf(fb->wlr_buf, &attribs)) {
@@ -508,7 +508,7 @@ static void atomic_connector_add(struct atomic *atom,
 			DRM_MODE_CONTENT_TYPE_GRAPHICS);
 	}
 	if (modeset && active && conn->props.max_bpc != 0 && conn->max_bpc_bounds[1] != 0) {
-		atomic_add(atom, conn->id, conn->props.max_bpc, pick_max_bpc(conn, state->primary_fb));
+		atomic_add(atom, conn->id, conn->props.max_bpc, drm_atomic_pick_max_bpc(conn, state->primary_fb));
 	}
 	if (conn->props.colorspace != 0) {
 		atomic_add(atom, conn->id, conn->props.colorspace, state->colorspace);
diff --git a/backend/drm/drm.c b/backend/drm/drm.c
index bd29872..6142ced 100644
--- a/backend/drm/drm.c
+++ b/backend/drm/drm.c
@@ -887,8 +887,8 @@ static bool drm_connector_prepare(struct wlr_drm_connector_state *conn_state, bo
 	}

 	if ((state->committed & WLR_OUTPUT_STATE_IMAGE_DESCRIPTION) &&
-			conn->backend->iface != &atomic_iface) {
-		wlr_log(WLR_DEBUG, "Image descriptions are only supported by the atomic interface");
+			conn->backend->iface == &legacy_iface) {
+		wlr_log(WLR_DEBUG, "Image descriptions are not supported by the legacy interface");
 		return false;
 	}

diff --git a/backend/drm/libliftoff.c b/backend/drm/libliftoff.c
index 333beac..bdbe7eb 100644
--- a/backend/drm/libliftoff.c
+++ b/backend/drm/libliftoff.c
@@ -320,7 +320,32 @@ static bool add_connector(drmModeAtomicReq *req,
 		ok = ok && add_prop(req, conn->id, conn->props.content_type,
 			DRM_MODE_CONTENT_TYPE_GRAPHICS);
 	}
-	// TODO: set "max bpc"
+	/*
+	 * Colour depth and colour management, the three connector properties the
+	 * atomic interface sets. The two colour-management values are already
+	 * computed for us by the shared drm_atomic_connector_prepare(), and the
+	 * metadata blob is freed by the shared apply/rollback, so all that was
+	 * missing was putting them in the request.
+	 *
+	 * max bpc has to come with them rather than after: it is derived from the
+	 * scanned-out format and clamped to what the connector advertises, and left
+	 * alone it keeps whatever the previous DRM master set - so signalling BT2020
+	 * and PQ without it means asking for HDR and possibly transmitting it at 8
+	 * bits, or attempting deep colour on a link that cannot carry it.
+	 */
+	if (modeset && active && conn->props.max_bpc != 0 &&
+			conn->max_bpc_bounds[1] != 0) {
+		ok = ok && add_prop(req, conn->id, conn->props.max_bpc,
+			drm_atomic_pick_max_bpc(conn, state->primary_fb));
+	}
+	if (conn->props.colorspace != 0) {
+		ok = ok && add_prop(req, conn->id, conn->props.colorspace,
+			state->colorspace);
+	}
+	if (conn->props.hdr_output_metadata != 0) {
+		ok = ok && add_prop(req, conn->id, conn->props.hdr_output_metadata,
+			state->hdr_output_metadata);
+	}
 	ok = ok &&
 		add_prop(req, crtc->id, crtc->props.mode_id, state->mode_id) &&
 		add_prop(req, crtc->id, crtc->props.active, active);
diff --git a/include/backend/drm/iface.h b/include/backend/drm/iface.h
index bc96105..848bc79 100644
--- a/include/backend/drm/iface.h
+++ b/include/backend/drm/iface.h
@@ -35,6 +35,14 @@ bool create_fb_damage_clips_blob(struct wlr_drm_backend *drm,
 	int width, int height, const pixman_region32_t *damage, uint32_t *blob_id);
 bool drm_atomic_reset(struct wlr_drm_backend *drm);

+/**
+ * Colour depth to ask a connector for, given the buffer being scanned out.
+ *
+ * Shared with the libliftoff interface, which builds its own atomic request.
+ */
+uint64_t drm_atomic_pick_max_bpc(struct wlr_drm_connector *conn,
+	struct wlr_drm_fb *fb);
+
 bool drm_atomic_connector_prepare(struct wlr_drm_connector_state *state,
 	bool modeset);
 void drm_atomic_connector_apply_commit(struct wlr_drm_connector_state *state);
```
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
| `ycbcr-opaque`         | `wlroots-0001-render-p030-is-opaque.patch`                            | `Closes` issue 1           | Answered upstream: the general fix is !5271, our one-line P030 addition stands until it lands WITH P030 on the list. See issue 1 above.    |
| `liftoff-colour-props` | `wlroots-0002-drm-colour-props-on-the-liftoff-interface.patch`        | `Closes` issue 2           | Ready. Must stay ONE commit — the guard narrowing without the property hunk turns a clean refusal into silently ignored colour management. |
| `liftoff-deadline`     | `wlroots-0005-drm-give-libliftoff-a-deadline-it-can-finish-in.patch`  | References #3794 and !4348 | Ready, and quote !4348's description in the MR: upstream documented the problem and never fixed it.                                        |
| —                      | `wlroots-0004` (scene offload) and `wlroots-0006` (composition layer) | #3794 / !4348              | **Hold.** Send the comment above first. These two only make sense together, and the scene half overlaps !4348 by design.                   |

The numbers in that table are the ones on the files today. They moved once already,
when `wlroots-0003` (the backend feature bit) went in ahead of the scene half, and
the numbers here were left behind — worth a look whenever a patch is added, since
the set is applied in filename order.

`labwc-0001` went to <https://github.com/labwc/labwc> as an ordinary pull
request — **[labwc#3685](https://github.com/labwc/labwc/pull/3685)**, opened
2026-08-03 against `master`. It is independent of everything above and stands on
its own: a failed render-format probe leaving the format at the last candidate it
tried is a bug with or without layers.

**It shrank in review, and the reason is worth keeping.** The first version also
described the output's layers in every state labwc builds itself. johanmalm asked
what sway does differently, since sway carries no such array — and the answer is
that sway builds a fresh `wlr_output_state` per frame and probes formats on a
separate config state, while labwc reuses one long-lived `output->pending` for
both, so in labwc a state can still carry `WLR_OUTPUT_STATE_LAYERS` when a probe
re-tests it. Chasing that down, the layer half turned out to be compensating for
an earlier iteration of `wlroots-0004`, which kept its output layer alive between
episodes where it now destroys it. Rebuilt without the layer half and measured:
the offload still engages, three planes in use, no `All output layers must be
specified`, no failed commits, 0 dropped frames at 2160p. So the patch is two
lines and a comment now.

**Then it changed shape once more, and that reason is worth keeping too.**
cillian64 asked for the state's `WLR_OUTPUT_STATE_RENDER_FORMAT` bit to be
cleared rather than the previously working format re-set: a `wlr_output_state`
is a diff, and clearing the bit says "do not change the format at all" instead
of asserting a value. It is also the safer of the two. Re-setting re-arms the
bit, so `output_basic_test()` runs `output_pick_format()` again on the current
format and can fail the whole commit for an output whose applied format is no
longer pickable (a bandwidth-limited new mode, a renderer swap); clearing has no
such path. He also asked for a debug line, since a probe that rejects every
candidate is otherwise invisible - it is gated on the existing `silent` flag,
because `output_state_setup_hdr()` runs twice per output on a config apply and
the second pass is deliberately quiet. Retested on `tvbox-livingroom` with the
final shape: three planes in use, compositor GPU time 0, 0 dropped and 0 delayed
frames, no format errors and no failed commits.

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

## A third wlroots bug, found after the first two were filed

`wlroots-0007`, and worth filing alongside the other two: **a resolution change
fails outright on the libliftoff interface.**

wlroots attaches an empty buffer to the output for a modeset
(`output_ensure_buffer`), and `backend/drm/libliftoff.c` then refuses the whole
commit if libliftoff did not give the cursor layer a plane:

```c
if (crtc->cursor && liftoff_layer_needs_composition(crtc->cursor->liftoff_layer)) {
    wlr_drm_conn_log(conn, WLR_DEBUG, "Failed to scan-out cursor plane");
    goto out;
}
```

Right for an ordinary frame - there is no other way to draw a cursor on that path

- and wrong for a modeset, whose allocation describes a configuration that is
  about to change over a buffer holding nothing. The cursor is re-evaluated on the
  first real frame either way.

Measured on a Pi 5: 3840x2160 -> 1920x1080 fails **5 times out of 5** with
`WLR_DRM_FORCE_LIBLIFTOFF=1`, succeeds without it, and succeeds on labwc 0.9.8 /
wlroots 0.19. The only clue is that one DEBUG line; what the compositor tells the
caller is "failed to apply configuration".

What it looks like to a user: a TV stuck on a film's 24 Hz mode after the film
ends, with everything on it - menus, games - feeling slow.

The fix is one condition: skip the check when `state->modeset` is set.

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

## HDR on the plane path (2026-08-05)

`wlroots-0008` and `wlroots-0009` are what let a 4K HDR film reach the display
**in HDR** without giving up the plane offload. Measured on `tvbox-livingroom`
with the TV in HDR mode: connector `colorspace=BT2020_RGB`, the film's P030
buffer on the primary plane, the app's UI on an overlay, labwc GPU time **0 ns
over 10 s**, and no dropped frames once playback settles.

They are two halves of one gate, and it took a wrong turn to find the second.

**0008 — why the renderer has to claim something it cannot do.** labwc refuses
HDR unless `renderer->features.output_color_transform` is set, and only the
Vulkan renderer sets it. Vulkan is not usable here (see the sections above), so
GLES2 has to report it. The claim is bounded: nothing in `render/gles2` reads
`options->color_transform`, so a transform is ignored rather than refused, and
in the plane path nothing is composited to transform in the first place.

**`input_color_transform` must stay false, and this is the part to remember.**
It looks like the same kind of harmless claim, and it is not: it makes labwc
advertise `wp_color_manager_v1`, and the Chromium-based UI, seeing colour
management, starts rendering in a wider space and expects the compositor to
convert. Nothing converts. The owner spotted it immediately - "a Home sokkal
fakóbb mint korábban" - and reverting to the shipped build restored it.

**0009 — and why advertising it looked necessary at first.** With the protocol
advertised, mpv tags its buffer PQ/BT2020 and `wlr_scene`'s scan-out rule is
satisfied. Without it, every buffer reads as the DEFAULT sRGB/gamma2.2 - not as
"untagged", which is the trap: a first attempt relaxed the untagged case and
changed nothing, because that case never occurs. The diagnostic that settled it:

```text
DIAG scanout refused: colour management (img_desc=0x..., buffer tf=8 prim=1)
```

`tf=8` is GAMMA22, `prim=1` is SRGB - for a PQ video buffer. So 0009 drops the
comparison when the output carries an image description and trusts a policy
instead: **the compositor only puts an output in a colour space while content in
that space is playing.** The shell has to keep that promise; until it does,
`<hdr>` stays off in the config and both patches are inert.

**Upstream shape.** Neither patch is proposable as is - one reports a capability
it lacks, the other removes a check. The honest upstream fix is a colour
transform implementation in the GLES2 renderer, at which point both disappear.

## The offload's own backoff was the film-start stutter (2026-08-05)

Measured on `tvbox-livingroom`, a 4K HDR title started through the ordinary path,
sampling labwc's `drm-engine-render` from `/proc/<labwc>/fdinfo/*` every 200 ms:
the compositor burns **345-597 ms of GPU render time per second for the first
4.6 s of the film**, then drops to **0.00 ms/s** for the rest of it. mpv is
innocent throughout - `frame-drop-count`, `vo-delayed-frame-count` and
`decoder-frame-drop-count` all stay at 0 and `estimated-vf-fps` holds 24.0 - so
what the viewer sees is presentation, not decoding.

It was `SCENE_OFFLOAD_BACKOFF` in `wlroots-0004`, and the unit was the bug: 60
**frames** is one second at 60 Hz and two and a half at 23.976, the rate a 24p
film runs at. The arming that fired is the one with no log line, inside
`scene_try_layer_offload` where the offload's own `scene_entry_try_direct_scanout`
comes back short. Proof it was that path rather than a backend refusal: **zero**
`Output layer refused` / `giving up on this output` lines in the whole 47k-line
log.

The trigger sat one layer up. `shell/hdr.js` writes the config and sends SIGHUP;
`labwc-0002` then committed the HDR state from inside the reload, which lands on a
page-flip already in flight often enough to matter - `a page-flip is already
pending`, `Failed to commit frame` - and a failed commit leaves
`WLR_OUTPUT_STATE_RENDER_FORMAT` on labwc's long-lived pending state. A state
carrying that bit is refused direct scan-out by `scene_entry_try_direct_scanout`,
so the offload's attempt came back `SCANOUT_INELIGIBLE` and armed the wait. labwc's
own comment at that site had predicted exactly this consequence.

Both halves are fixed here, and both changes are the kind upstream would want
anyway:

- `wlroots-0004` expresses the wait as a duration, waits only on a failed **test**
  (an ineligible scene is decided before any round trip and changes frame to
  frame, so re-deciding it is cheap), and logs the first time either wait is
  armed.
- `labwc-0002` schedules a frame instead of committing inside the reload, so the
  colour space rides along with the next frame's damage after the flip completes.

**Measured again with both fixes installed**, same title, same method:

|                                            | before    | after      |
| ------------------------------------------ | --------- | ---------- |
| composited window at the start of the film | 4.67 s    | **0.08 s** |
| samples over 1 ms/s of GPU render time     | 25        | **2**      |
| dropped / delayed / decoder-dropped frames | 0 / 0 / 0 | 0 / 0 / 0  |

The two frames that remain are the modeset itself. The log confirms both halves
independently: no `failed to apply the HDR state` line and no
`a page-flip is already pending` anywhere, and no `Offload held off` line at all -
the wait is never armed now. Total disturbance from the film mapping to scan-out
being back: 699 ms, of which about 53 ms is four commits refused for
`Failed to scan-out cursor plane`. Those are the `wlroots-0007` class on ordinary
frames rather than a modeset, so that patch correctly does not suppress them; they
were there before this work as well.

Worth keeping as a technique: `drm-engine-render` on the compositor's `renderD128`
fd needs no root and separates the two candidate causes on its own - climbing means
frames are being composited, flat while mpv reports no drops means the panel is
re-locking its mode and nothing in the box can help.

**The explicit-synchronisation stand-down costs this box nothing**, which was a
measurement rather than a hope. With the check installed, a film start produced zero
`Not offloading: the top surface uses explicit synchronisation` lines and the offload
engaged as before - so Chromium's surface here does not use
`wp_linux_drm_syncobj_v1`, and refusing one that does is free insurance. Same run
also showed the offload engaging TWICE in one start, which is the `offload_active`
fix visible from outside: before it, the second engagement was silent and scheduled
no frame to read its own verdict.

### One review finding deliberately not acted on

The offload layer can outlive the state that would have disabled it, by two routes:
`scene_output_disable_offload_layer()` returns early when the state already carries
`WLR_OUTPUT_STATE_LAYERS`, before reaching the branch that would drop the layer; and
`wlr_scene_output_destroy()` destroys it without the disabled-layer frame first. Both
are real, and both are left alone for now:

- the main path is already handled by the two-step the code was written around -
  describe the layer disabled for one frame, THEN drop it, gated on
  `offload_disabled`;
- the early return needs a compositor that sets output layers of its own, which is
  the case `scene_try_layer_offload()` explicitly stands down on;
- the destroy case is output teardown, where the plane configuration is going away
  with it.

If either is ever revisited, the smaller change is to test `layers > 1` before the
`WLR_OUTPUT_STATE_LAYERS` early return, so an output that gained a layer elsewhere
stops owning ours rather than keeping it undescribed.
