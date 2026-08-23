import { createMover, nearest, pinScroll } from "@sdk/moveTo";

// The shared transform movement. `createMover` and `nearest` are also exercised
// through the media client's own suite; what is new here is `pinScroll`, and it is
// the piece with no visible failure mode - a page moved by a transform simply ends
// up in the wrong place, with the transform reading exactly what it should.

describe("pinScroll", () => {
  it("puts a clipping box back to zero when something scrolls it", () => {
    // `overflow: hidden` clips but stays SCROLLABLE programmatically, and the
    // browser scrolls the nearest such ancestor whenever focus lands outside it -
    // as does any scrollIntoView, which FocusButton calls on focus. So a page
    // moved by a transform carries two offsets, and only one of them is known.
    const el = document.createElement("div");
    const pin = pinScroll();
    pin(el);

    el.scrollTop = 240;
    el.scrollLeft = 80;
    el.dispatchEvent(new Event("scroll"));
    expect(el.scrollTop).toBe(0);
    expect(el.scrollLeft).toBe(0);
  });

  it("resets a box that is already scrolled when it is attached", () => {
    const el = document.createElement("div");
    el.scrollTop = 100;
    pinScroll()(el);
    expect(el.scrollTop).toBe(0);
  });

  it("lets go of the previous element", () => {
    // Otherwise a re-render that swaps the node leaves a listener holding the old
    // one, and every swap adds another.
    const first = document.createElement("div");
    const second = document.createElement("div");
    const pin = pinScroll();
    pin(first);
    pin(second);

    first.scrollTop = 50;
    first.dispatchEvent(new Event("scroll"));
    expect(first.scrollTop).toBe(50);

    second.scrollTop = 50;
    second.dispatchEvent(new Event("scroll"));
    expect(second.scrollTop).toBe(0);
  });

  it("survives being detached", () => {
    const el = document.createElement("div");
    const pin = pinScroll();
    pin(el);
    pin(null);
    el.scrollTop = 30;
    el.dispatchEvent(new Event("scroll"));
    expect(el.scrollTop).toBe(30);
  });
});

describe("the mover", () => {
  it("writes where it sits into the DOM", () => {
    // Same reason a focusable carries `data-sfocus`: a check about movement needs
    // something to read, and the transform string is the thing under test rather
    // than a witness to it.
    const el = document.createElement("div");
    const mover = createMover("y");
    mover.attach(el);
    expect(el.dataset.at).toBe("0");
    mover.to(120, false);
    expect(el.dataset.at).toBe("120");
    expect(el.style.transform).toBe("translateY(-120px)");
  });

  it("never moves past the start", () => {
    const mover = createMover("x");
    mover.attach(document.createElement("div"));
    mover.to(-50, false);
    expect(mover.at).toBe(0);
  });
});

describe("nearest", () => {
  const base = { viewport: 900, size: 200, max: 5000 };

  it("does not move for something already inside", () => {
    expect(nearest({ ...base, at: 0, start: 300 })).toBe(0);
  });

  it("brings a band above the window down to it, with its padding", () => {
    expect(nearest({ ...base, at: 1000, start: 800, padStart: 40 })).toBe(760);
  });

  it("brings a band below the window up, with its padding", () => {
    expect(nearest({ ...base, at: 0, start: 1000, padEnd: 40 })).toBe(340);
  });

  it("never goes past either end", () => {
    expect(nearest({ ...base, at: 0, start: -500 })).toBe(0);
    expect(nearest({ ...base, at: 0, start: 9000 })).toBe(4100);
  });
});

describe("a move that replaces one still running", () => {
  // The element is somewhere between the last two positions, but `current` is a
  // DESTINATION - set the moment `to` was called. So the replacement keyframe used
  // to start where the previous move was HEADING, and on a held arrow the list
  // jumped forward before animating. `commitStyles` writes the animation's present
  // value into the inline style, which is then just a string to read back.
  function element(commitThrows = false) {
    const el = document.createElement("div");
    const animations: Array<{ keyframes: Array<Record<string, string>>; committed: boolean; cancelled: boolean }> = [];
    (el as unknown as { animate: unknown }).animate = (keyframes: Array<Record<string, string>>) => {
      const rec = { keyframes, committed: false, cancelled: false };
      animations.push(rec);
      return {
        // What a browser does: persist the value the animation is showing RIGHT
        // NOW into the element's own style.
        commitStyles: () => {
          if (commitThrows) throw new Error("not rendered");
          rec.committed = true;
          el.style.transform = "matrix(1, 0, 0, 1, 0, -37)";
        },
        cancel: () => {
          rec.cancelled = true;
        },
      } as unknown as Animation;
    };
    return { el, animations };
  }

  it("starts from where the element IS, not from the last destination", () => {
    const { el, animations } = element();
    const mover = createMover("y");
    mover.attach(el);

    mover.to(200, true);
    expect(animations[0].keyframes[0].transform).toBe("translateY(0px)");
    // …and now, mid-flight, a second press.
    mover.to(400, true);
    expect(animations[0].committed, "the running animation has to be committed first").toBe(true);
    expect(animations[0].cancelled).toBe(true);
    expect(animations[1].keyframes[0].transform).toBe("matrix(1, 0, 0, 1, 0, -37)");
    expect(animations[1].keyframes[1].transform).toBe("translateY(-400px)");
  });

  it("falls back to the destination when the element cannot be committed", () => {
    // `commitStyles` throws for an element that is not rendered, and an unmoving
    // list is a worse failure than a jumping one.
    const { el, animations } = element(true);
    const mover = createMover("y");
    mover.attach(el);
    mover.to(200, true);
    expect(() => mover.to(400, true)).not.toThrow();
    expect(animations[1].keyframes[0].transform).toBe("translateY(-200px)");
  });

  it("does not reach for a running animation when there is none", () => {
    const { el, animations } = element();
    const mover = createMover("y");
    mover.attach(el);
    mover.to(200, true);
    expect(animations[0].keyframes[0].transform).toBe("translateY(0px)");
    expect(animations[0].committed).toBe(false);
  });
});
