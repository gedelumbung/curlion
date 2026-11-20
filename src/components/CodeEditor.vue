<!-- Multi-line code editor (CodeMirror 6) for request bodies, responses and snippets. -->
<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { html } from '@codemirror/lang-html'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { baseTheme, refreshVars, variableCompletion, variableHighlighter } from '../lib/cm.js'
import { scope } from '../store.js'
import { theme } from '../lib/theme.js'

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
const highlightExt = (t) => syntaxHighlighting(t === 'light' ? defaultHighlightStyle : oneDarkHighlightStyle)

const langExt = (l) => (l === 'json' ? json() : l === 'xml' ? xml() : l === 'html' ? html() : [])

onMounted(() => {
  view = new EditorView({
    parent: el.value,
    state: EditorState.create({
      doc: props.modelValue ?? '',
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        highlightConf.of(highlightExt(theme.value)),
        baseTheme,
        langConf.of(langExt(props.language)),
        wrapConf.of(props.wrap ? EditorView.lineWrapping : []),
        EditorState.readOnly.of(props.readonly),
        props.variables ? [variableHighlighter(() => scope.value), variableCompletion(() => scope.value)] : [],
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
watch(scope, () => props.variables && view?.dispatch({ effects: refreshVars.of(null) }))

onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <div ref="el" class="code-editor h-full overflow-auto"></div>
</template>
