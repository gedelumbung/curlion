<!-- Multi-line code editor (CodeMirror 6) for request bodies, responses and snippets. -->
<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState, Prec, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
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
import { SearchQuery, highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { html } from '@codemirror/lang-html'
import { baseTheme, highlightStyleFor, codeTheme, refreshVars, urlLinks, variableClick, variableCompletion, variableHighlighter } from '../lib/cm.js'
import { openVarPopover, scope } from '../store.js'
import { palette, theme } from '../lib/theme.js'
import { indentString, settings } from '../lib/settings.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  language: { type: String, default: 'text' }, // json | xml | html | text
  readonly: { type: Boolean, default: false },
  variables: { type: Boolean, default: true },
  wrap: { type: Boolean, default: false },
  links: { type: Boolean, default: false }, // make http(s) URLs clickable (opens a new tab)
  findKey: { type: Boolean, default: false }, // Ctrl/⌘+F emits 'find' (the parent shows its own search bar)
})
const emit = defineEmits(['update:modelValue', 'find', 'matches']) // matches: { count, index, error }

const el = ref(null)
let view = null
const langConf = new Compartment()
const wrapConf = new Compartment()
const highlightConf = new Compartment()
const highlightExt = () => syntaxHighlighting(highlightStyleFor(palette.value, theme.value))
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

// ---- search driven by the parent (search(spec), step(dir)) ----------------------------------
// CodeMirror only highlights search matches while its own panel is open, so matches are
// drawn here as decorations.
const MAX_MATCHES = 10_000
const setMatches = StateEffect.define()
const matchMark = Decoration.mark({ class: 'cm-searchMatch' })
const currentMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' })
const matchField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) if (e.is(setMatches)) deco = Decoration.set(e.value.ranges.map((r, i) => (i === e.value.current ? currentMark : matchMark).range(r.from, r.to)))
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})
let searchSpec = null
let ranges = []
let current = -1

function applyMatches(scroll) {
  if (!view) return
  const effects = [setMatches.of({ ranges, current })]
  if (scroll && current >= 0) effects.push(EditorView.scrollIntoView(ranges[current].from, { y: 'center' }))
  view.dispatch({ effects })
  emit('matches', { count: ranges.length, index: current, capped: ranges.length >= MAX_MATCHES, error: null })
}

/** Highlight every match of spec = { text, caseSensitive, regexp, wholeWord }; empty text clears. */
function search(spec, { keepIndex = false, scroll = true } = {}) {
  searchSpec = spec?.text ? { ...spec } : null
  const prev = current
  ranges = []
  current = -1
  if (!view) return
  if (!searchSpec) return applyMatches(false)
  const q = new SearchQuery({ search: spec.text, caseSensitive: !!spec.caseSensitive, regexp: !!spec.regexp, wholeWord: !!spec.wholeWord, literal: !spec.regexp })
  if (!q.valid) {
    view.dispatch({ effects: setMatches.of({ ranges: [], current: -1 }) })
    emit('matches', { count: 0, index: -1, error: 'Invalid regular expression' })
    return
  }
  const cur = q.getCursor(view.state)
  for (let r = cur.next(); !r.done && ranges.length < MAX_MATCHES; r = cur.next()) if (r.value.to > r.value.from) ranges.push({ from: r.value.from, to: r.value.to })
  current = ranges.length ? (keepIndex && prev >= 0 ? Math.min(prev, ranges.length - 1) : 0) : -1
  applyMatches(scroll)
}
/** Go to the next (1) or previous (-1) match. */
function step(dir) {
  if (!ranges.length) return
  current = (current + dir + ranges.length) % ranges.length
  applyMatches(true)
}
defineExpose({ search, step })

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
        highlightConf.of(highlightExt()),
        baseTheme,
        codeTheme,
        langConf.of(langExt(props.language)),
        wrapConf.of(props.wrap ? EditorView.lineWrapping : []),
        EditorState.readOnly.of(props.readonly),
        props.links ? urlLinks() : [],
        matchField,
        props.findKey ? Prec.highest(keymap.of([{ key: 'Mod-f', run: () => (emit('find'), true) }])) : [],
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
      if (searchSpec) search(searchSpec, { keepIndex: true, scroll: false }) // new content: find again
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
watch([theme, palette], () => view?.dispatch({ effects: highlightConf.reconfigure(highlightExt()) }))
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
