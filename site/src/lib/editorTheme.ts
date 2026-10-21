import { createTheme } from '@uiw/codemirror-themes'
import { tags as t } from '@lezer/highlight'

// Every colour is a CSS variable from custom.css, so one theme follows Starlight's light/dark
// switch; `theme` only tells CodeMirror which built-in panel styles to use.
const settings = {
  background: 'var(--rdkit-editor-bg)',
  foreground: 'var(--sl-color-white)',
  caret: 'var(--sl-color-accent-high)',
  selection: 'var(--rdkit-editor-selection)',
  selectionMatch: 'var(--rdkit-editor-selection)',
  lineHighlight: 'var(--rdkit-editor-line)',
  gutterBackground: 'var(--rdkit-editor-bg)',
  gutterForeground: 'var(--sl-color-gray-4)',
  gutterActiveForeground: 'var(--sl-color-gray-2)',
  gutterBorder: 'transparent',
  fontFamily: 'var(--__sl-font-mono)',
}

const styles = [
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--rdkit-syn-keyword)' },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: 'var(--rdkit-syn-function)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--rdkit-syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--rdkit-syn-number)' },
  { tag: [t.typeName, t.special(t.name)], color: 'var(--rdkit-syn-type)' },
  { tag: [t.lineComment, t.blockComment], color: 'var(--rdkit-syn-comment)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--sl-color-gray-3)' },
]

export const editorThemes = {
  dark: createTheme({ theme: 'dark', settings, styles }),
  light: createTheme({ theme: 'light', settings, styles }),
}
