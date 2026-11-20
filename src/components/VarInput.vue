<!-- Single-line input with {{variable}} highlighting and autocomplete (CodeMirror 6). -->
<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { completionKeymap, completionStatus } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { baseTheme, refreshVars, singleLineTheme, variableCompletion, variableHighlighter } from '../lib/cm.js'
import { scope } from '../store.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  masked: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'enter', 'paste-text'])

const el = ref(null)
let view = null

onMounted(() => {
  view = new EditorView({
    parent: el.value,
    state: EditorState.create({
      doc: props.modelValue ?? '',
      extensions: [
        history(),
        keymap.of([
          {
            key: 'Enter',
            run: (v) => {
              if (completionStatus(v.state) === 'active') return false
              emit('enter')
              return true
            },
          },
          ...completionKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        cmPlaceholder(props.placeholder),
        variableHighlighter(() => scope.value),
        variableCompletion(() => scope.value),
        baseTheme,
        singleLineTheme,
        EditorView.contentAttributes.of({ class: props.masked ? 'cm-masked' : '' }),
        // keep it a single line
        EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr)),
        EditorView.domEventHandlers({
          paste: (event, v) => {
            const text = event.clipboardData?.getData('text/plain') || ''
            // Let the parent intercept (e.g. cURL import). It sets handled=true to take over.
            const payload = { text, handled: false }
            emit('paste-text', payload)
            if (payload.handled) {
              event.preventDefault()
              return true
            }
            if (text.includes('\n')) {
              event.preventDefault()
              v.dispatch(v.state.replaceSelection(text.replace(/\r?\n\s*/g, ' ')))
              return true
            }
            return false
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
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
watch(scope, () => view?.dispatch({ effects: refreshVars.of(null) }))

onBeforeUnmount(() => view?.destroy())

defineExpose({ focus: () => view?.focus() })
</script>

<template>
  <div ref="el" class="var-input min-w-0" :class="{ masked }"></div>
</template>
