// Detecting http(s) URLs in response text so they can be opened in a new tab.

/** http(s) URLs, without trailing punctuation (e.g. "see https://x.io." or "(https://x.io)"). */
export const URL_RE = /https?:\/\/[^\s"'<>`\\]*[^\s"'<>`\\.,;:!?)\]}]/g

/** Splits text into [{ text, url? }] segments; url is set on the parts that are links. */
export function linkParts(text) {
  const parts = []
  let last = 0
  for (const m of String(text).matchAll(URL_RE)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) })
    parts.push({ text: m[0], url: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}
