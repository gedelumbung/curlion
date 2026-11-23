// CodeMirror extensions: {{variable}} highlighting, click-to-edit popover hook, autocomplete.
import { Decoration, EditorView, MatchDecorator, ViewPlugin } from '@codemirror/view'
import { StateEffect } from '@codemirror/state'
import { autocompletion } from '@codemirror/autocomplete'
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { DYNAMIC_DESCRIPTIONS, DYNAMIC_VARS } from './variables.js'
import { URL_RE } from './links.js'

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

/** CodeMirror highlight style from a palette's syntax colours. */
function syntaxStyle(c) {
  return HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: c.keyword },
    { tag: [t.propertyName, t.attributeName], color: c.property },
    { tag: [t.string, t.special(t.string)], color: c.string },
    { tag: t.regexp, color: c.regexp },
    { tag: [t.number, t.bool, t.null, t.atom], color: c.number },
    { tag: [t.tagName], color: c.tag },
    { tag: [t.typeName, t.className], color: c.type },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: c.func },
    { tag: [t.comment, t.meta], color: c.comment, fontStyle: 'italic' },
    { tag: [t.punctuation, t.separator, t.bracket], color: c.punct },
    { tag: t.operator, color: c.operator },
    { tag: t.invalid, color: c.invalid },
  ])
}

/** Syntax colours per palette and mode (see PALETTES in lib/theme.js). */
const SYNTAX = {
  ayu: {
    // https://github.com/ayu-theme/ayu-colors
    dark: { keyword: '#ff8f40', property: '#59c2ff', string: '#aad94c', regexp: '#95e6cb', number: '#d2a6ff', tag: '#39bae6', type: '#59c2ff', func: '#ffb454', comment: '#acb6bf8c', punct: '#bfbdb6b3', operator: '#f29668', invalid: '#d95757' },
    light: { keyword: '#fa8d3e', property: '#399ee6', string: '#86b300', regexp: '#4cbf99', number: '#a37acc', tag: '#55b4d4', type: '#399ee6', func: '#f2ae49', comment: '#787b8099', punct: '#5c6166b3', operator: '#ed9366', invalid: '#e65050' },
  },
  monokai: {
    dark: { keyword: '#f92672', property: '#66d9ef', string: '#e6db74', regexp: '#e6db74', number: '#ae81ff', tag: '#f92672', type: '#66d9ef', func: '#a6e22e', comment: '#75715e', punct: '#f8f8f2b3', operator: '#f92672', invalid: '#f92672' },
    light: { keyword: '#e14775', property: '#1c8ca8', string: '#cc7a0a', regexp: '#cc7a0a', number: '#7058be', tag: '#e14775', type: '#1c8ca8', func: '#269d69', comment: '#a59fa0', punct: '#29242ab3', operator: '#e14775', invalid: '#e14775' },
  },
  dracula: {
    dark: { keyword: '#ff79c6', property: '#8be9fd', string: '#f1fa8c', regexp: '#ff5555', number: '#bd93f9', tag: '#ff79c6', type: '#8be9fd', func: '#50fa7b', comment: '#6272a4', punct: '#f8f8f2b3', operator: '#ff79c6', invalid: '#ff5555' },
    light: { keyword: '#a3144d', property: '#036a96', string: '#846e15', regexp: '#cb3a2a', number: '#644ac9', tag: '#a3144d', type: '#036a96', func: '#14710a', comment: '#6c664b', punct: '#1f1f1fb3', operator: '#a3144d', invalid: '#cb3a2a' },
  },
  tokyo: {
    dark: { keyword: '#bb9af7', property: '#7aa2f7', string: '#9ece6a', regexp: '#b4f9f8', number: '#ff9e64', tag: '#f7768e', type: '#2ac3de', func: '#7aa2f7', comment: '#565f89', punct: '#a9b1d6b3', operator: '#89ddff', invalid: '#f7768e' },
    light: { keyword: '#9854f1', property: '#2e7de9', string: '#587539', regexp: '#2e5857', number: '#b15c00', tag: '#f52a65', type: '#007197', func: '#2e7de9', comment: '#848cb5', punct: '#3760bfb3', operator: '#006a83', invalid: '#f52a65' },
  },
}
const styleCache = new Map()

/** Highlight style for a palette ('ayu' | 'monokai' | 'dracula' | 'tokyo') and mode ('dark' | 'light'). */
export function highlightStyleFor(palette, mode) {
  const key = `${palette}:${mode}`
  if (!styleCache.has(key)) styleCache.set(key, syntaxStyle((SYNTAX[palette] || SYNTAX.ayu)[mode === 'light' ? 'light' : 'dark']))
  return styleCache.get(key)
}

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

const urlMatcher = new MatchDecorator({
  regexp: URL_RE,
  decoration: (m) => Decoration.mark({ class: 'cm-url', attributes: { 'data-url': m[0], title: `Open ${m[0]} in a new tab` } }),
})

/**
 * Underlines http(s) URLs and opens them in a new tab on click (for read-only editors such as
 * the response viewer). A click that ends a text selection does not open the link.
 */
export function urlLinks() {
  return [
    ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.decorations = urlMatcher.createDeco(view)
        }
        update(u) {
          this.decorations = urlMatcher.updateDeco(u, this.decorations)
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.domEventHandlers({
      click(e, view) {
        const el = e.target instanceof Element ? e.target.closest('.cm-url[data-url]') : null
        if (!el || e.button !== 0 || !view.state.selection.main.empty) return false
        window.open(el.dataset.url, '_blank', 'noopener,noreferrer')
        return true
      },
    }),
    EditorView.theme({
      '.cm-url': { textDecoration: 'underline', textDecorationColor: 'color-mix(in srgb, currentColor 45%, transparent)', textUnderlineOffset: '2px', cursor: 'pointer' },
      '.cm-url:hover': { textDecorationColor: 'currentColor' },
    }),
  ]
}
