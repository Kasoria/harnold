import { useEffect, useRef } from "react";
// Side effect: Monaco and its workers come from the bundle, no CDN (see monaco-local.ts).
import { monaco } from "@/lib/monaco-local";

type CodeEditorProps = {
  path: string;
  value: string;
  language: string;
  theme: "light" | "dark";
  onChange: (value: string) => void;
};

/**
 * Thin wrapper around Monaco. Loaded lazily by the workspace pane, so the editor only arrives
 * when the code view is opened. One model per file keeps cursor, selection and undo history
 * when switching between files.
 */
export default function CodeEditor(props: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  useEffect(() => {
    if (!containerRef.current) return;
    const editor = monaco.editor.create(containerRef.current, {
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      padding: { top: 12 },
      automaticLayout: true,
    });
    editorRef.current = editor;
    const contentSubscription = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()));
    return () => {
      contentSubscription.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // One model per file: the language belongs to the file, not to the editor.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const modelUri = monaco.Uri.file(`/${props.path}`);
    const model = monaco.editor.getModel(modelUri) ?? monaco.editor.createModel(props.value, props.language, modelUri);
    if (model.getValue() !== props.value) model.setValue(props.value);
    if (editor.getModel() !== model) editor.setModel(model);
    // props.value is applied by the effects below; re-creating on every keystroke would lose undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path]);

  // The agent may rewrite the open file. Edits instead of setValue, so undo keeps working.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || model.getValue() === props.value) return;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: props.value }], () => null);
  }, [props.value]);

  useEffect(() => {
    monaco.editor.setTheme(props.theme === "dark" ? "vs-dark" : "vs");
  }, [props.theme]);

  return <div ref={containerRef} className="size-full" />;
}
