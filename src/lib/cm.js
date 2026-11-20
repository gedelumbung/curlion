// CodeMirror extensions: {{variable}} highlighting with hover values + autocomplete.
import { Decoration, EditorView, MatchDecorator, ViewPlugin } from '@codemirror/view'
import { StateEffect } from '@codemirror/state'
import { autocompletion } from '@codemirror/autocomplete'
import { DYNAMIC_DESCRIPTIONS, DYNAMIC_VARS } from './variables.js'

/** Dispatch this effect to re-evaluate highlighting after the variable scope changes. */
export const refreshVars = StateEffect.define()

/**
 * @param getScope () => Map<key, {value,isSecret,source}>
 */
export function variableHighlighter(getScope) {
  const decoFor = (name) => {
    if (name in DYNAMIC_VARS) {
      return Decoration.mark({ class: 'cm-var cm-var-dynamic', attributes: { title: `${name} — ${DYNAMIC_DESCRIPTIONS[name]} (generated on send)` } })
    }
    const v = getScope().get(name)
    if (!v) return Decoration.mark({ class: 'cm-var cm-var-missing', attributes: { title: `${name} is not defined in the active environment or Globals` } })
    const shown = v.isSecret ? '••••••' : v.value === '' ? '(empty)' : v.value
    return Decoration.mark({ class: 'cm-var cm-var-ok', attributes: { title: `${name} = ${shown}   [${v.source}]` } })
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
