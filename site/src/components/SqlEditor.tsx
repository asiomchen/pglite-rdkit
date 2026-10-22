import { useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { PostgreSQL, SQLDialect, sql, type SQLNamespace } from '@codemirror/lang-sql'
import { completeFromList, completionStatus } from '@codemirror/autocomplete'
import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { useStarlightTheme } from '../lib/theme'
import { editorThemes } from '../lib/editorTheme'

interface Props {
  value: string
  onChange: (value: string) => void
  /**
   * Mod-Enter, or plain Enter when `enterRuns` is set; gets the editor's text. With `enterRuns`,
   * returning false means "not accepted" (e.g. still busy) and keeps the text in the editor
   */
  onRun: (text: string) => unknown
  schema?: SQLNamespace
  functions?: string[]
  /** REPL behaviour: Enter runs and clears the editor, Shift-Enter inserts a newline */
  enterRuns?: boolean
  /** REPL history navigation: the entry to show, or undefined to leave the editor alone */
  onHistory?: (direction: -1 | 1) => string | undefined
  /** Ctrl-C with nothing selected, like psql; return false to let the key through */
  onCancel?: () => boolean
  minHeight?: string
  autoFocus?: boolean
}

export default function SqlEditor({
  value,
  onChange,
  onRun,
  schema,
  functions = [],
  enterRuns = false,
  onHistory,
  onCancel,
  minHeight,
  autoFocus,
}: Props) {
  const theme = useStarlightTheme()
  // the keymap is built once, so read the latest callbacks through refs
  const handlers = useRef({ onRun, onHistory, onCancel })
  handlers.current = { onRun, onHistory, onCancel }

  const extensions = useMemo(() => {
    // listing the RDKit functions as builtins gets them highlighted like Postgres' own
    const dialect = functions.length
      ? SQLDialect.define({
          ...PostgreSQL.spec,
          builtin: `${PostgreSQL.spec.builtin ?? ''} ${functions.join(' ')}`,
        })
      : PostgreSQL
    const language = sql({ dialect, schema, upperCaseKeywords: true })
    // with the autocomplete popup open, Enter and the arrows belong to it
    const completing = (view: EditorView) => completionStatus(view.state) === 'active'
    const atEdge = (view: EditorView, direction: -1 | 1) => {
      if (completing(view)) return false
      const { head } = view.state.selection.main
      const line = view.state.doc.lineAt(head).number
      return direction === -1 ? line === 1 : line === view.state.doc.lines
    }
    // the editor's own text is replaced here, not through the `value` prop: the wrapper ignores
    // prop changes for a moment after each keystroke, which would drop a clear right after typing
    const replace = (view: EditorView, text: string) =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
      })
    const run = (view: EditorView) => {
      const accepted = handlers.current.onRun(view.state.doc.toString())
      if (enterRuns && accepted !== false) replace(view, '')
      return true
    }
    const browse = (view: EditorView, direction: -1 | 1) => {
      if (!atEdge(view, direction)) return false
      const text = handlers.current.onHistory?.(direction)
      if (text === undefined) return false
      replace(view, text)
      return true
    }
    // with a selection, Ctrl-C stays copy (it is copy on Windows and Linux)
    const cancel = (view: EditorView) =>
      view.state.selection.main.empty && (handlers.current.onCancel?.() ?? false)
    return [
      language,
      language.language.data.of({
        autocomplete: completeFromList(functions.map((label) => ({ label, type: 'function' }))),
      }),
      Prec.highest(
        keymap.of([
          { key: 'Mod-Enter', run },
          { key: 'Ctrl-c', run: cancel },
          ...(enterRuns
            ? [
                { key: 'Enter', run: (view: EditorView) => !completing(view) && run(view) },
                { key: 'ArrowUp', run: (view: EditorView) => browse(view, -1) },
                { key: 'ArrowDown', run: (view: EditorView) => browse(view, 1) },
              ]
            : []),
        ]),
      ),
      EditorView.lineWrapping,
    ]
  }, [schema, functions, enterRuns])

  return (
    <CodeMirror
      className={enterRuns ? 'rdkit-editor rdkit-editor-inline' : 'rdkit-editor'}
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={editorThemes[theme]}
      minHeight={minHeight}
      autoFocus={autoFocus}
      basicSetup={{
        lineNumbers: !enterRuns,
        foldGutter: false,
        highlightActiveLine: !enterRuns,
        highlightActiveLineGutter: !enterRuns,
      }}
    />
  )
}
