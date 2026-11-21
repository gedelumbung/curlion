// CodeMirror extensions: {{variable}} highlighting, click-to-edit popover hook, autocomplete.
import { Decoration, EditorView, MatchDecorator, ViewPlugin } from '@codemirror/view'
import { StateEffect } from '@codemirror/state'
import { autocompletion } from '@codemirror/autocomplete'
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { DYNAMIC_DESCRIPTIONS, DYNAMIC_VARS } from './variables.js'

/** Dispatch this effect to re-evaluate highlighting after the variable scope changes. */
export const refreshVars = StateEffect.define()

/**
 * @param getScope () => Map<key, {value,isSecret,source}>
 */
export function variableHighlighter(getScope) {
  // data-var lets variableClick() know which variable was clicked
  const decoFor = (name) => {
    if (name in DYNAMIC_VARS) {
      return Decoration.mark({ class: 'cm-var cm-var-dynamic', attributes: { 'data-var': name, title: `${name}: ${DYNAMIC_DESCRIPTIONS[name]} (generated on send)` } })
    }
    const v = getScope().get(name)
    if (!v) return Decoration.mark({ class: 'cm-var cm-var-missing', attributes: { 'data-var': name, title: `${name} is not defined. Click to add it.` } })
    const shown = v.isSecret ? '••••••' : v.value === '' ? '(empty)' : v.value
    return Decoration.mark({ class: 'cm-var cm-var-ok', attributes: { 'data-var': name, title: `${name} = ${shown}   [${v.source}${v.isCurrent ? ', your current value' : ''}]  Click to edit.` } })
  }

  const matcher = new MatchDecorator({
    regexp: /\{\{\s*([^{}\s]+)\s*\}\}/g,
    decoration: (m) => decoFor(m[1]),
  })

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = matcher.createDeco(view)
      }
      update(u) {
        const forced = u.transactions.some((t) => t.effects.some((e) => e.is(refreshVars)))
        this.decorations = forced ? matcher.createDeco(u.view) : matcher.updateDeco(u, this.decorations)
      }
    },
    { decorations: (v) => v.decorations },
  )
}

/**
 * Clicking a highlighted {{variable}} calls onClick(name, anchorRect) (used for the inline
 * edit popover). The click still places the cursor as usual.
 */
export function variableClick(onClick) {
  return EditorView.domEventHandlers({
    click(e) {
      const el = e.target instanceof Element ? e.target.closest('.cm-var[data-var]') : null
      if (el && !e.shiftKey && !e.metaKey && !e.ctrlKey) onClick(el.dataset.var, el.getBoundingClientRect())
      return false
    },
  })
}

export function variableCompletion(getScope) {
  return autocompletion({
    activateOnTyping: true,
    icons: false,
    override: [
      (ctx) => {
        const m = ctx.matchBefore(/\{\{[^{}\s]*$/)
        if (!m) return null
        const scope = getScope()
        const options = [
          ...[...scope.entries()].map(([key, v]) => ({
            label: key,
            detail: v.isSecret ? '••••••' : String(v.value).slice(0, 40),
            type: 'variable',
            apply: `{{${key}}}`,
            boost: 1,
          })),
          ...Object.keys(DYNAMIC_VARS).map((key) => ({ label: key, detail: DYNAMIC_DESCRIPTIONS[key], type: 'constant', apply: `{{${key}}}` })),
        ]
        // swallow an auto-inserted or existing "}}" right after the cursor
        const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2)
        return {
          from: m.from,
          to: after === '}}' ? ctx.pos + 2 : ctx.pos,
          options: options.map((o) => ({ ...o, label: o.label })),
          filter: true,
          getMatch: undefined,
          validFor: /^\{\{[^{}\s]*$/,
        }
      },
    ],
  })
}

/** Syntax colors for the dark theme (Dracula). */
export const draculaHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: '#ff79c6' },
  { tag: [t.propertyName, t.attributeName], color: '#8be9fd' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#f1fa8c' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#bd93f9' },
  { tag: [t.tagName, t.typeName, t.className], color: '#ff79c6' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#50fa7b' },
  { tag: [t.comment, t.meta], color: '#6272a4', fontStyle: 'italic' },
  { tag: [t.punctuation, t.separator, t.bracket, t.operator], color: '#f8f8f2' },
  { tag: t.invalid, color: '#ff5555' },
])

/** Syntax colors for the light theme: muted, low-glare. */
export const softLightHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: '#8a4f9e' },
  { tag: [t.propertyName, t.attributeName], color: '#2f6690' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#4d7c3a' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#a65a3a' },
  { tag: [t.tagName, t.typeName, t.className], color: '#8a4f9e' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#2f6690' },
  { tag: [t.comment, t.meta], color: '#8b919c', fontStyle: 'italic' },
  { tag: [t.punctuation, t.separator, t.bracket, t.operator], color: '#5d6473' },
  { tag: t.invalid, color: '#c0392b' },
])

export const baseTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: 'var(--color-zinc-200)', fontSize: '13px' },
    '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--color-orange-400)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--color-zinc-600)' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgb(128 128 128 / 0.07)' },
    '.cm-tooltip': { backgroundColor: 'var(--color-zinc-800)', border: '1px solid var(--color-zinc-700)', borderRadius: '6px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--color-orange-500)', color: 'white' },
    '.cm-completionDetail': { color: 'var(--color-zinc-400)', marginLeft: '1em', fontStyle: 'normal' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgb(249 115 22 / 0.25) !important' },
  },
)

export const singleLineTheme = EditorView.theme({
  '.cm-content': { padding: '0' },
  '.cm-line': { padding: '0' },
  '.cm-scroller': { overflow: 'hidden', lineHeight: '1.5' },
})
