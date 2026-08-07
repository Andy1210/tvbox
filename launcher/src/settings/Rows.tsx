import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useFocusableItem } from "../lib/useFocusableItem";
import { Osk } from "../components/Osk";

// The vocabulary every settings page is built from. Three things are shared here
// rather than restyled per panel, which is what the old screens got wrong:
//
//  - **One focus look, and it costs nothing to move.** A focused row swaps to a
//    white fill with dark text and SNAPS - no transform, no colour transition.
//    Neither of those is compositable on this hardware, and animating them per
//    D-pad press is what took navigation to 16.6 fps at 4K. Motion belongs to page
//    changes, where it happens once, not to the thing the remote does 20 times a
//    second.
//  - **Secondary text inherits.** Hints and values are `currentColor` at reduced
//    opacity, never a fixed dim grey, so they stay readable when the row flips to a
//    white background. A fixed colour is invisible on focus and nobody notices
//    until they are on the couch.
//  - **Rows carry their own focus key in the DOM** (`data-sfocus`), which is how
//    SettingsPage finds a default to focus and how it tells a page with nothing to
//    press from one whose rows have not loaded yet.
const PageContext = createContext<string>("page");

export const PageScope = PageContext.Provider;
export const usePageId = (): string => useContext(PageContext);

const rowKey = (page: string, id: string) => `${page}:${id}`;

// Rounded card holding a run of rows, with hairline dividers. The focused row
// fills edge to edge inside it, so the group is what gives the list its shape -
// no per-row scale, which would be clipped here and re-rasterise the row anyway.
export function Group({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-[2.6vh]">
      {title && (
        <h3 className="text-[1.7vh] font-bold uppercase tracking-[0.12em] text-fg-dim mb-[1vh] px-[0.4vw]">{title}</h3>
      )}
      {hint && <p className="text-[1.8vh] text-fg-dim mb-[1.2vh] px-[0.4vw] max-w-[48vw] leading-snug">{hint}</p>}
      <div className="rounded-[1.4vh] bg-white/[0.055] overflow-hidden divide-y divide-white/[0.07]">{children}</div>
    </section>
  );
}

function RowShell({
  id,
  onEnter,
  autoFocus,
  disabled,
  children,
}: {
  id: string;
  onEnter: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
  children: (focused: boolean) => ReactNode;
}) {
  const page = usePageId();
  const key = rowKey(page, id);
  const { ref, focused } = useFocusableItem(
    { focusKey: key, onEnterPress: () => !disabled && onEnter(), focusable: !disabled },
    { block: "nearest" },
  );
  // A row that becomes disabled WHILE it is focused keeps spatial navigation's focus
  // (turning `focusable` off does not move it), so without this it would go on
  // wearing the bright focus fill while silently ignoring every press. Showing it as
  // unfocused is the honest half; the page's focus watchdog moves the focus on.
  const lit = focused && !disabled;
  return (
    <div
      ref={ref}
      onClick={() => !disabled && onEnter()}
      data-sfocus={disabled ? undefined : key}
      data-sautofocus={autoFocus && !disabled ? "" : undefined}
      className={[
        "flex items-center gap-[1.6vw] px-[2vw] py-[1.9vh] min-h-[7.4vh]",
        lit ? "bg-white text-[#06090d]" : "",
        disabled ? "opacity-40" : "",
      ].join(" ")}
    >
      {children(lit)}
    </div>
  );
}

// label + optional hint, sharing the row's colour so both survive the focus flip
function Labels({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block text-[2.2vh] font-semibold leading-tight">{label}</span>
      {hint && <span className="block text-[1.7vh] opacity-60 leading-snug mt-[0.3vh]">{hint}</span>}
    </span>
  );
}

const chevron = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-[2.4vh] h-[2.4vh] shrink-0 opacity-35"
    aria-hidden="true"
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

// The workhorse: a pressable row. `value` is the current setting shown on the
// right (a network name, "not set up"), `trailing` is the affordance - a chevron
// when pressing it goes somewhere, nothing when it acts in place.
export function Row({
  id,
  label,
  hint,
  value,
  leading,
  trailing = "chevron",
  onEnter,
  autoFocus,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  value?: ReactNode;
  // A glyph before the label, for the one thing a row cannot say in words without
  // taking a line for it: a network is password protected, a Bluetooth device is a
  // speaker rather than a keyboard. It inherits the row's colour, so it survives the
  // focus flip like everything else.
  leading?: ReactNode;
  trailing?: "chevron" | "none";
  onEnter: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <RowShell id={id} onEnter={onEnter} autoFocus={autoFocus} disabled={disabled}>
      {() => (
        <>
          {leading && <span className="w-[2.8vh] h-[2.8vh] shrink-0 opacity-70">{leading}</span>}
          <Labels label={label} hint={hint} />
          {value != null && value !== "" && (
            <span className="text-[1.9vh] opacity-70 shrink-0 max-w-[20vw] truncate text-right">{value}</span>
          )}
          {trailing === "chevron" && chevron}
        </>
      )}
    </RowShell>
  );
}

// An on/off setting. The pill is the state, not a separate control to aim at -
// pressing anywhere on the row flips it.
export function ToggleRow({
  id,
  label,
  hint,
  on,
  onToggle,
  onWord,
  offWord,
  autoFocus,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  on: boolean;
  onToggle: () => void;
  onWord: string;
  offWord: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <RowShell id={id} onEnter={onToggle} autoFocus={autoFocus} disabled={disabled}>
      {(focused) => (
        <>
          <Labels label={label} hint={hint} />
          <span
            className={[
              "shrink-0 text-[1.7vh] font-bold uppercase tracking-wide px-[1.1vw] py-[0.7vh] rounded-full",
              on
                ? focused
                  ? "bg-[#06090d] text-white"
                  : "bg-accent text-[#06090d]"
                : focused
                  ? "bg-black/15 text-[#06090d]"
                  : "bg-white/10 text-fg-dim",
            ].join(" ")}
          >
            {on ? onWord : offWord}
          </span>
        </>
      )}
    </RowShell>
  );
}

// A stepper for a small numeric range (idle minutes, a sleep timer). Left/right
// change the value, so it needs no sub-page and no keyboard.
export function StepperRow({
  id,
  label,
  hint,
  display,
  onStep,
  autoFocus,
}: {
  id: string;
  label: string;
  hint?: string;
  display: string;
  onStep: (delta: number) => void;
  autoFocus?: boolean;
}) {
  const page = usePageId();
  const key = rowKey(page, id);
  const { ref, focused } = useFocusableItem(
    {
      focusKey: key,
      // OK does nothing on purpose. Left and right are the control, and a volume row
      // that jumped 5% because someone pressed OK to "select" it would be a surprise
      // every time.
      onEnterPress: () => {},
      // Arrows are the control here, so this row consumes left/right instead of
      // letting spatial nav carry focus out of the page.
      onArrowPress: (dir: string) => {
        if (dir !== "left" && dir !== "right") return true;
        onStep(dir === "right" ? 1 : -1);
        return false;
      },
    },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      data-sfocus={key}
      data-sautofocus={autoFocus ? "" : undefined}
      className={[
        "flex items-center gap-[1.6vw] px-[2vw] py-[1.9vh] min-h-[7.4vh]",
        focused ? "bg-white text-[#06090d]" : "",
      ].join(" ")}
    >
      <Labels label={label} hint={hint} />
      <span className="flex items-center gap-[1vw] shrink-0 tabular-nums">
        <span className={"text-[2vh] " + (focused ? "opacity-45" : "opacity-25")} aria-hidden="true">
          ‹
        </span>
        <span className="text-[2vh] font-semibold min-w-[7vw] text-center">{display}</span>
        <span className={"text-[2vh] " + (focused ? "opacity-45" : "opacity-25")} aria-hidden="true">
          ›
        </span>
      </span>
    </div>
  );
}

// A row whose value is typed. Every credential form in Settings is this shape, and
// each one used to re-implement it: open the keyboard, take the string, put the
// focus back. Two rules are folded in here so no form can get them wrong.
//
//  - **A stored secret is never read back.** `secret` shows a fixed mask when one
//    is set (the box only ever tells us `hasPassword`), and submitting an empty
//    string means "keep what is stored" rather than "clear it" - the same contract
//    the shell's config routes use.
//  - **The keyboard is an overlay, not a replacement.** The OSK is a focus
//    boundary, so the page stays mounted behind it and this row gets the focus back
//    when it closes. Swapping the page out for the keyboard instead would remount
//    it, and the user would come back to the top of the list every time.
const SECRET_MASK = "••••••••";

export function TextRow({
  id,
  label,
  hint,
  value,
  title,
  onSubmit,
  secret,
  hasSecret,
  emptyLabel,
  autoFocus,
}: {
  id: string;
  label: string;
  hint?: string;
  // The current value, shown on the right. Ignored for a secret.
  value?: string;
  // Heading for the keyboard - say which field is being typed.
  title: string;
  onSubmit: (text: string) => void;
  secret?: boolean;
  hasSecret?: boolean;
  // What to show when there is no value yet ("not set").
  emptyLabel?: string;
  autoFocus?: boolean;
}) {
  const page = usePageId();
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    void setFocus(rowKey(page, id));
  };
  const shown = secret ? (hasSecret ? SECRET_MASK : emptyLabel) : value || emptyLabel;
  return (
    <>
      <Row
        id={id}
        label={label}
        hint={hint}
        value={shown}
        trailing="none"
        autoFocus={autoFocus}
        onEnter={() => setOpen(true)}
      />
      {open &&
        // Portalled to the body: the row lives inside a Group whose card clips and
        // divides its children, and a page mid-slide still has a transform, which
        // would make itself the containing block for anything fixed inside it.
        createPortal(
          <Osk
            title={title}
            // A secret is never pre-filled - we do not have it to pre-fill.
            initial={secret ? "" : value || ""}
            onDone={(text: string) => {
              onSubmit(text);
              close();
            }}
            onCancel={close}
          />,
          document.body,
        )}
    </>
  );
}

// A read-only fact (diagnostics, an address the user copies by eye). Deliberately
// not focusable: a row nobody can act on should not cost a D-pad press to pass,
// which is why the About page scrolls instead.
export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-[1.6vw] px-[2vw] py-[1.6vh] min-h-[6vh]">
      <span className="text-[2vh] flex-1 min-w-0">{label}</span>
      <span className="text-[2vh] text-fg-dim shrink-0 max-w-[26vw] truncate text-right tabular-nums">{value}</span>
    </div>
  );
}

// Prose under a group: what a setting means, or what just went wrong. `tone`
// picks the colour; the text is never the only signal, so it stays readable
// without one.
export function Note({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "warn" | "accent" | "ok" }) {
  const color = { dim: "text-fg-dim", warn: "text-warn", accent: "text-accent", ok: "text-success" }[tone];
  return (
    <p className={`text-[1.8vh] leading-snug mb-[1.6vh] px-[0.4vw] max-w-[52vw] min-w-0 break-words ${color}`}>
      {children}
    </p>
  );
}

// A status line at the top of a page: what the box currently thinks, before any
// row offers to change it.
export function StatusBanner({
  icon,
  title,
  detail,
  tone = "dim",
}: {
  icon?: ReactNode;
  title: string;
  detail?: string;
  tone?: "dim" | "accent" | "warn";
}) {
  const color = { dim: "text-fg-dim", accent: "text-accent", warn: "text-warn" }[tone];
  return (
    <div className="flex items-center gap-[1.2vw] mb-[2.2vh] px-[0.4vw]">
      {icon && <span className={`w-[2.8vh] h-[2.8vh] shrink-0 ${color}`}>{icon}</span>}
      <span className="text-[2.1vh] font-semibold">{title}</span>
      {detail && <span className="text-[1.9vh] text-fg-dim min-w-0 truncate">{detail}</span>}
    </div>
  );
}
