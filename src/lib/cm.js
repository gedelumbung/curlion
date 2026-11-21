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

/** Syntax colors, Ayu Dark (https://github.com/ayu-theme/ayu-colors). */
export const ayuDarkHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: '#ff8f40' },
  { tag: [t.propertyName, t.attributeName], color: '#59c2ff' },
  { tag: [t.string, t.special(t.string)], color: '#aad94c' },
  { tag: t.regexp, color: '#95e6cb' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#d2a6ff' },
  { tag: [t.tagName], color: '#39bae6' },
  { tag: [t.typeName, t.className], color: '#59c2ff' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#ffb454' },
  { tag: [t.comment, t.meta], color: '#acb6bf8c', fontStyle: 'italic' },
  { tag: [t.punctuation, t.separator, t.bracket], color: '#bfbdb6b3' },
  { tag: t.operator, color: '#f29668' },
  { tag: t.invalid, color: '#d95757' },
])

/** Syntax colors, Ayu Light. */
export const ayuLightHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: '#fa8d3e' },
  { tag: [t.propertyName, t.attributeName], color: '#399ee6' },
  { tag: [t.string, t.special(t.string)], color: '#86b300' },
  { tag: t.regexp, color: '#4cbf99' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#a37acc' },
  { tag: [t.tagName], color: '#55b4d4' },
  { tag: [t.typeName, t.className], color: '#399ee6' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#f2ae49' },
  { tag: [t.comment, t.meta], color: '#787b8099', fontStyle: 'italic' },
  { tag: [t.punctuation, t.separator, t.bracket], color: '#5c6166b3' },
  { tag: t.operator, color: '#ed9366' },
  { tag: t.invalid, color: '#e65050' },
])

export const baseTheme = EditorView.theme(
  {
    // font family / size come from Settings (CSS variables set by lib/settings.js)
    '&': { backgroundColor: 'transparent', color: 'var(--color-zinc-200)', fontSize: 'var(--editor-font-size, 13px)' },
    '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--color-orange-500)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-orange-500)', borderLeftWidth: '2px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--color-zinc-600)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-zinc-400)' },
    '.cm-activeLine': { backgroundColor: 'var(--cm-active-line)' },
    '.cm-matchingBracket': { backgroundColor: 'transparent', outline: '1px solid var(--color-zinc-600)' },
    '.cm-tooltip': { backgroundColor: 'var(--color-zinc-900)', border: '1px solid var(--color-zinc-700)', borderRadius: '5px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--color-zinc-800)', color: 'var(--color-zinc-100)' },
    '.cm-completionDetail': { color: 'var(--color-zinc-500)', marginLeft: '1em', fontStyle: 'normal' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--cm-selection) !important' },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--color-orange-500) 25%, transparent)' },
  },
)

/** Multi-line editors: "font padding" from Settings = space above and below each line. */
export const codeTheme = EditorView.theme({
  '.cm-line': { paddingTop: 'var(--editor-line-pad, 2px)', paddingBottom: 'var(--editor-line-pad, 2px)' },
  // gutters follow the line heights CodeMirror measures; only centre their contents
  '.cm-gutterElement': { display: 'flex', alignItems: 'center' },
  '.cm-lineNumbers .cm-gutterElement': { justifyContent: 'flex-end' },
})

export const singleLineTheme = EditorView.theme({
  '.cm-content': { padding: '0' },
  '.cm-line': { padding: '0' },
  '.cm-scroller': { overflow: 'hidden', lineHeight: '1.5' },
})
