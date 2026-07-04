import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdownRendering } from "../lib/cm-markdown.ts";
import { toggleWrap, continueList } from "../lib/markdown-edit.ts";

// Typing one of these over a non-empty selection wraps it instead of replacing
// it (select a span, hit ` to make it code).
const WRAP_CHARS = new Set(["`", "*", "_"]);

// Imperative surface the Composer drives for caret-precise edits (picking a
// slash command / @ file, inserting "@", etc.).
export interface MarkdownInputHandle {
  focus(): void;
  getCaret(): number;
  // Replace the whole document and place the selection at [selStart, selEnd]
  // (collapsed caret at selStart when selEnd is omitted; end of doc when both
  // are omitted).
  setValue(value: string, selStart?: number, selEnd?: number): void;
}

// Live callbacks the (once-created) keymap reads. Held in a ref so the editor
// doesn't need rebuilding when Composer state changes.
export interface MarkdownInputCallbacks {
  isTouch: boolean;
  onSubmit(): void;
  // Menu navigation: each returns true when a menu consumed the key (so the
  // editor leaves the caret/text alone), false to fall through to normal editing.
  onMenuEnter(): boolean;
  onArrow(dir: 1 | -1): boolean;
  onTab(): boolean;
  onEscape(): boolean;
}

interface Props {
  value: string;
  placeholder: string;
  className?: string;
  onChange(value: string, caret: number): void;
  onPasteFiles?(files: File[]): void;
  callbacksRef: React.MutableRefObject<MarkdownInputCallbacks>;
}

// Replace the whole document with `r.text` and select [r.selStart, r.selEnd].
function applyEdit(view: EditorView, r: { text: string; selStart: number; selEnd: number }) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: r.text },
    selection: { anchor: r.selStart, head: r.selEnd },
    scrollIntoView: true,
  });
}

// Continue a markdown list on this newline, or insert a plain newline.
function continueOrNewline(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (sel.empty) {
    const r = continueList(view.state.doc.toString(), sel.head);
    if (r) { applyEdit(view, r); return true; }
  }
  view.dispatch(view.state.replaceSelection("\n"));
  return true;
}

function wrapSelection(view: EditorView, marker: string): boolean {
  const sel = view.state.selection.main;
  applyEdit(view, toggleWrap(view.state.doc.toString(), sel.from, sel.to, marker));
  return true;
}

// A markdown-aware composer input built on CodeMirror: the document is plain
// markdown text (what we send the agent), rendered inline as you type. It mirrors
// the old <textarea>'s contract — a controlled `value` + onChange(value, caret)
// — so the Composer's slash/@ menus and send logic are unchanged.
export const MarkdownInput = forwardRef<MarkdownInputHandle, Props>(function MarkdownInput(
  { value, placeholder, className, onChange, onPasteFiles, callbacksRef },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest onChange/onPasteFiles, read by the editor's (stable) extensions.
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onPasteRef = useRef(onPasteFiles); onPasteRef.current = onPasteFiles;
  // Holds the placeholder extension so it can be reconfigured when the connected
  // agent (and thus the prompt) changes, without rebuilding the editor.
  const placeholderComp = useRef(new Compartment());

  useEffect(() => {
    const cb = () => callbacksRef.current;
    const keys = Prec.highest(keymap.of([
      { key: "Enter", run: (view) => {
        if (cb().onMenuEnter()) return true;     // a menu consumed it (pick)
        if (!cb().isTouch) { cb().onSubmit(); return true; } // desktop: send
        return continueOrNewline(view);          // touch: newline (+list continue)
      } },
      { key: "Shift-Enter", run: continueOrNewline },
      { key: "ArrowDown", run: () => cb().onArrow(1) },
      { key: "ArrowUp", run: () => cb().onArrow(-1) },
      { key: "Tab", run: () => cb().onTab() },
      { key: "Escape", run: () => cb().onEscape() },
      { key: "Mod-b", run: (v) => wrapSelection(v, "**") },
      { key: "Mod-i", run: (v) => wrapSelection(v, "*") },
      { key: "Mod-e", run: (v) => wrapSelection(v, "`") },
    ]));

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          keys,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          placeholderComp.current.of(cmPlaceholder(placeholder)),
          markdownRendering(),
          // Wrap a selection when a markdown delimiter is typed over it.
          EditorView.inputHandler.of((v, from, to, text) => {
            if (from !== to && WRAP_CHARS.has(text)) {
              applyEdit(v, toggleWrap(v.state.doc.toString(), from, to, text));
              return true;
            }
            return false;
          }),
          EditorView.domEventHandlers({
            paste: (e) => {
              const cb2 = onPasteRef.current;
              if (!cb2) return false;
              const imgs = Array.from(e.clipboardData?.items || [])
                .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
                .map((it) => it.getAsFile())
                .filter((f): f is File => !!f);
              if (imgs.length) { e.preventDefault(); cb2(imgs); return true; }
              return false;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged || u.selectionSet) {
              onChangeRef.current(u.state.doc.toString(), u.state.selection.main.head);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // Built once; live values flow through refs (onChange/onPaste/callbacks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the editor's document in sync when `value` is driven from outside
  // (e.g. cleared on send). Edits the user makes already match, so this no-ops
  // for them and never fights the caret.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (value !== cur) {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
        selection: { anchor: Math.min(value.length, view.state.selection.main.head) },
      });
    }
  }, [value]);

  // Keep the placeholder current (it switches with the connected agent's skin).
  useEffect(() => {
    viewRef.current?.dispatch({ effects: placeholderComp.current.reconfigure(cmPlaceholder(placeholder)) });
  }, [placeholder]);

  useImperativeHandle(ref, (): MarkdownInputHandle => ({
    focus: () => viewRef.current?.focus(),
    getCaret: () => viewRef.current?.state.selection.main.head ?? 0,
    setValue: (val, selStart, selEnd) => {
      const view = viewRef.current;
      if (!view) return;
      const anchor = selStart ?? val.length;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: val },
        selection: { anchor, head: selEnd ?? anchor },
      });
    },
  }), []);

  return <div ref={host} className={className} />;
});
