import { Component, type ReactNode } from "react";

// Last-resort crash screen. On a keyboardless TV a render exception would
// otherwise leave a black screen with no way out - so catch it and offer a
// reload on OK (the CEC remote's OK arrives as Enter, which activates the
// autofocused native button). Deliberately bilingual-hardcoded like the
// first-run language picker: the crash may have come from the i18n layer
// itself, so this screen must not depend on it.
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[launcher] crashed:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-full flex flex-col items-center justify-center gap-[2vh] px-[8vw] text-center bg-[#0a0f16]">
        <div className="text-[4vh] font-bold">Something went wrong · Hiba történt</div>
        <div className="text-[2vh] text-white/60 max-w-[60vw] break-words">
          {String(this.state.error.message || this.state.error)}
        </div>
        <button
          autoFocus
          onClick={() => window.location.reload()}
          className="mt-[2vh] px-[3vw] py-[2vh] rounded-[1.4vh] bg-white/10 text-[2.4vh] font-semibold transition-[background-color,color] duration-150 focus:outline-none focus:bg-white focus:text-[#06090d]"
        >
          Restart · Újraindítás
        </button>
      </div>
    );
  }
}
