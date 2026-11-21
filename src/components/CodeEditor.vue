<!-- Multi-line code editor (CodeMirror 6) for request bodies, responses and snippets. -->
<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { html } from '@codemirror/lang-html'
import { ayuDarkHighlightStyle, ayuLightHighlightStyle, baseTheme, codeTheme, refreshVars, variableClick, variableCompletion, variableHighlighter } from '../lib/cm.js'
import { openVarPopover, scope } from '../store.js'
import { theme } from '../lib/theme.js'
import { indentString, settings } from '../lib/settings.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  language: { type: String, default: 'text' }, // json | xml | html | text
  readonly: { type: Boolean, default: false },
  variables: { type: Boolean, default: true },
  wrap: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const el = ref(null)
let view = null
const langConf = new Compartment()
const wrapConf = new Compartment()
const highlightConf = new Compartment()
const highlightExt = (t) => syntaxHighlighting(t === 'light' ? ayuLightHighlightStyle : ayuDarkHighlightStyle)
// Settings: indentation (spaces/tabs, size) and auto-closing quotes/brackets
const indentConf = new Compartment()
const indentExt = () => [indentUnit.of(indentString()), EditorState.tabSize.of(settings.indentSize)]
const closeConf = new Compartment()
const closeExt = () => (settings.autoClose ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : [])

// What codemirror's basicSetup provides, minus closeBrackets/autocompletion (configured separately)
const setup = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
]

const langExt = (l) => (l === 'json' ? json() : l === 'xml' ? xml() : l === 'html' ? html() : [])

onMounted(() => {
  view = new EditorView({
    parent: el.value,
    state: EditorState.create({
      doc: props.modelValue ?? '',
      extensions: [
        closeConf.of(closeExt()), // before the default keymap so Backspace deletes pairs
        setup,
        keymap.of([indentWithTab]),
        indentConf.of(indentExt()),
        highlightConf.of(highlightExt(theme.value)),
        baseTheme,
        codeTheme,
        langConf.of(langExt(props.language)),
        wrapConf.of(props.wrap ? EditorView.lineWrapping : []),
        EditorState.readOnly.of(props.readonly),
        props.variables ? [variableHighlighter(() => scope.value), variableCompletion(() => scope.value), variableClick(openVarPopover)] : [],
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !props.readonly) emit('update:modelValue', u.state.doc.toString())
        }),
      ],
    }),
  })
})

watch(
  () => props.modelValue,
  (val) => {
    if (view && val !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: val ?? '' } })
    }
  },
)
watch(
  () => props.language,
  (l) => view?.dispatch({ effects: langConf.reconfigure(langExt(l)) }),
)
watch(
  () => props.wrap,
  (w) => view?.dispatch({ effects: wrapConf.reconfigure(w ? EditorView.lineWrapping : []) }),
)
watch(theme, (t) => view?.dispatch({ effects: highlightConf.reconfigure(highlightExt(t)) }))
watch(
  () => [settings.indentType, settings.indentSize],
  () => view?.dispatch({ effects: indentConf.reconfigure(indentExt()) }),
)
watch(
  () => settings.autoClose,
  () => view?.dispatch({ effects: closeConf.reconfigure(closeExt()) }),
)
watch(scope, () => props.variables && view?.dispatch({ effects: refreshVars.of(null) }))

onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <div ref="el" class="code-editor h-full overflow-auto"></div>
</template>
