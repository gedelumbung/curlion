// Code snippet generator. Input is the output of resolveRequest().
import { urlencode } from './resolve.js'

export const SNIPPET_LANGS = [
  { id: 'curl', label: 'cURL (Bash)', cm: 'text' },
  { id: 'fetch', label: 'JavaScript (fetch)', cm: 'text' },
  { id: 'axios', label: 'JavaScript (Axios)', cm: 'text' },
  { id: 'php-curl', label: 'PHP (cURL)', cm: 'text' },
  { id: 'guzzle', label: 'PHP (Guzzle)', cm: 'text' },
  { id: 'go', label: 'Go (net/http)', cm: 'text' },
  { id: 'python', label: 'Python (requests)', cm: 'text' },
]

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'` // shell single quote
const js = (s) => JSON.stringify(String(s))
const php = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const goStr = (s) => (String(s).includes('`') ? JSON.stringify(String(s)) : '`' + s + '`')
const py = (s) => JSON.stringify(String(s))

/** Headers excluding the multipart content-type (libraries set it with the boundary). */
const visibleHeaders = (r) =>
  r.headers.filter((h) => !(r.body?.mode === 'form-data' && h.key.toLowerCase() === 'content-type'))

const prettyJson = (raw) => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return null
  }
}

const indent = (str, pad) => str.split('\n').join('\n' + pad)

export function generateSnippet(lang, r) {
  switch (lang) {
    case 'curl':
      return curl(r)
    case 'fetch':
      return fetchJs(r)
    case 'axios':
      return axios(r)
    case 'php-curl':
      return phpCurl(r)
    case 'guzzle':
      return guzzle(r)
    case 'go':
      return goHttp(r)
    case 'python':
      return python(r)
    default:
      return ''
  }
}

function curl(r) {
  const lines = [`curl --location --request ${r.method} ${sq(r.url)}`]
  for (const h of visibleHeaders(r)) lines.push(`--header ${sq(`${h.key}: ${h.value}`)}`)
  if (r.body?.mode === 'raw') lines.push(`--data-raw ${sq(r.body.raw)}`)
  if (r.body?.mode === 'urlencoded') for (const f of r.body.fields) lines.push(`--data-urlencode ${sq(`${f.key}=${f.value}`)}`)
  if (r.body?.mode === 'form-data')
    for (const f of r.body.fields) lines.push(`--form ${sq(f.type === 'file' ? `${f.key}=@"${f.fileName}"` : `${f.key}=${f.value}`)}`)
  return lines.join(' \\\n')
}

function fetchJs(r) {
  const out = []
  const hs = visibleHeaders(r)
  out.push('const myHeaders = new Headers();')
  for (const h of hs) out.push(`myHeaders.append(${js(h.key)}, ${js(h.value)});`)
  let bodyVar = null
  if (r.body?.mode === 'raw') {
    const pj = r.body.contentType === 'application/json' && prettyJson(r.body.raw)
    out.push('', pj ? `const raw = JSON.stringify(${pj});` : `const raw = ${js(r.body.raw)};`)
    bodyVar = 'raw'
  } else if (r.body?.mode === 'urlencoded') {
    out.push('', 'const urlencoded = new URLSearchParams();')
    for (const f of r.body.fields) out.push(`urlencoded.append(${js(f.key)}, ${js(f.value)});`)
    bodyVar = 'urlencoded'
  } else if (r.body?.mode === 'form-data') {
    out.push('', 'const formdata = new FormData();')
    for (const f of r.body.fields)
      out.push(f.type === 'file' ? `formdata.append(${js(f.key)}, fileInput.files[0], ${js(f.fileName)});` : `formdata.append(${js(f.key)}, ${js(f.value)});`)
    bodyVar = 'formdata'
  }
  out.push('', 'const requestOptions = {', `  method: ${js(r.method)},`, '  headers: myHeaders,')
  if (bodyVar) out.push(`  body: ${bodyVar},`)
  out.push('  redirect: "follow"', '};', '')
  out.push(`fetch(${js(r.url)}, requestOptions)`, '  .then((response) => response.text())', '  .then((result) => console.log(result))', '  .catch((error) => console.error(error));')
  return out.join('\n')
}

function axios(r) {
  const out = ["const axios = require('axios');"]
  let dataExpr = null
  if (r.body?.mode === 'raw') {
    const pj = r.body.contentType === 'application/json' && prettyJson(r.body.raw)
    out.push(pj ? `const data = JSON.stringify(${pj});` : `const data = ${js(r.body.raw)};`)
    dataExpr = 'data'
  } else if (r.body?.mode === 'urlencoded') {
    out.push('const data = new URLSearchParams({')
    for (const f of r.body.fields) out.push(`  ${js(f.key)}: ${js(f.value)},`)
    out.push('});')
    dataExpr = 'data'
  } else if (r.body?.mode === 'form-data') {
    out.unshift("const FormData = require('form-data');", "const fs = require('fs');")
    out.push('const data = new FormData();')
    for (const f of r.body.fields)
      out.push(f.type === 'file' ? `data.append(${js(f.key)}, fs.createReadStream(${js(f.fileName)}));` : `data.append(${js(f.key)}, ${js(f.value)});`)
    dataExpr = 'data'
  }
  out.push('', 'const config = {', `  method: ${js(r.method.toLowerCase())},`, `  url: ${js(r.url)},`, '  headers: {')
  for (const h of visibleHeaders(r)) out.push(`    ${js(h.key)}: ${js(h.value)},`)
  if (r.body?.mode === 'form-data') out.push('    ...data.getHeaders(),')
  out.push('  },')
  if (dataExpr) out.push(`  data: ${dataExpr},`)
  out.push('};', '', 'axios.request(config)', '  .then((response) => console.log(JSON.stringify(response.data)))', '  .catch((error) => console.log(error));')
  return out.join('\n')
}

function phpCurl(r) {
  const out = ['<?php', '', '$curl = curl_init();', '', 'curl_setopt_array($curl, [']
  out.push(`  CURLOPT_URL => ${php(r.url)},`, '  CURLOPT_RETURNTRANSFER => true,', '  CURLOPT_FOLLOWLOCATION => true,', `  CURLOPT_CUSTOMREQUEST => ${php(r.method)},`)
  if (r.body?.mode === 'raw') out.push(`  CURLOPT_POSTFIELDS => ${php(r.body.raw)},`)
  if (r.body?.mode === 'urlencoded') out.push(`  CURLOPT_POSTFIELDS => ${php(urlencode(r.body.fields))},`)
  if (r.body?.mode === 'form-data') {
    out.push('  CURLOPT_POSTFIELDS => [')
    for (const f of r.body.fields) out.push(`    ${php(f.key)} => ${f.type === 'file' ? `new CURLFile(${php(f.fileName)})` : php(f.value)},`)
    out.push('  ],')
  }
  const hs = visibleHeaders(r)
  if (hs.length) {
    out.push('  CURLOPT_HTTPHEADER => [')
    for (const h of hs) out.push(`    ${php(`${h.key}: ${h.value}`)},`)
    out.push('  ],')
  }
  out.push(']);', '', '$response = curl_exec($curl);', '', 'curl_close($curl);', 'echo $response;')
  return out.join('\n')
}

function guzzle(r) {
  const out = ['<?php', '', 'require "vendor/autoload.php";', '', 'use GuzzleHttp\\Client;', '', '$client = new Client();', '', '$options = [']
  const hs = visibleHeaders(r).filter((h) => !(r.body?.mode === 'urlencoded' && h.key.toLowerCase() === 'content-type'))
  if (hs.length) {
    out.push("  'headers' => [")
    for (const h of hs) out.push(`    ${php(h.key)} => ${php(h.value)},`)
    out.push('  ],')
  }
  if (r.body?.mode === 'raw') out.push(`  'body' => ${php(r.body.raw)},`)
  if (r.body?.mode === 'urlencoded') {
    out.push("  'form_params' => [")
    for (const f of r.body.fields) out.push(`    ${php(f.key)} => ${php(f.value)},`)
    out.push('  ],')
  }
  if (r.body?.mode === 'form-data') {
    out.push("  'multipart' => [")
    for (const f of r.body.fields)
      out.push(
        f.type === 'file'
          ? `    ['name' => ${php(f.key)}, 'contents' => fopen(${php(f.fileName)}, 'r'), 'filename' => ${php(f.fileName)}],`
          : `    ['name' => ${php(f.key)}, 'contents' => ${php(f.value)}],`,
      )
    out.push('  ],')
  }
  out.push('];', '', `$response = $client->request(${php(r.method)}, ${php(r.url)}, $options);`, '', 'echo $response->getBody();')
  return out.join('\n')
}

function goHttp(r) {
  const imports = new Set(['fmt', 'io', 'net/http'])
  const pre = []
  let bodyExpr = 'nil'
  if (r.body?.mode === 'raw') {
    imports.add('strings')
    pre.push(`\tpayload := strings.NewReader(${goStr(r.body.raw)})`, '')
    bodyExpr = 'payload'
  } else if (r.body?.mode === 'urlencoded') {
    imports.add('strings')
    pre.push(`\tpayload := strings.NewReader(${goStr(urlencode(r.body.fields))})`, '')
    bodyExpr = 'payload'
  } else if (r.body?.mode === 'form-data') {
    imports.add('bytes').add('mime/multipart').add('os')
    pre.push('\tpayload := &bytes.Buffer{}', '\twriter := multipart.NewWriter(payload)')
    for (const f of r.body.fields) {
      if (f.type === 'file') {
        imports.add('path/filepath')
        pre.push(
          `\tfile, _ := os.Open(${goStr(f.fileName)})`,
          '\tdefer file.Close()',
          `\tpart, _ := writer.CreateFormFile(${goStr(f.key)}, filepath.Base(${goStr(f.fileName)}))`,
          '\tio.Copy(part, file)',
        )
      } else pre.push(`\t_ = writer.WriteField(${goStr(f.key)}, ${goStr(f.value)})`)
    }
    pre.push('\tif err := writer.Close(); err != nil {', '\t\tfmt.Println(err)', '\t\treturn', '\t}', '')
    bodyExpr = 'payload'
  }
  const out = ['package main', '', 'import (']
  for (const i of [...imports].sort()) out.push(`\t"${i}"`)
  out.push(')', '', 'func main() {', `\turl := ${goStr(r.url)}`, `\tmethod := ${goStr(r.method)}`, '', ...pre)
  out.push('\tclient := &http.Client{}', `\treq, err := http.NewRequest(method, url, ${bodyExpr})`, '\tif err != nil {', '\t\tfmt.Println(err)', '\t\treturn', '\t}')
  for (const h of visibleHeaders(r)) out.push(`\treq.Header.Add(${goStr(h.key)}, ${goStr(h.value)})`)
  if (r.body?.mode === 'form-data') out.push('\treq.Header.Set("Content-Type", writer.FormDataContentType())')
  out.push('', '\tres, err := client.Do(req)', '\tif err != nil {', '\t\tfmt.Println(err)', '\t\treturn', '\t}', '\tdefer res.Body.Close()', '')
  out.push('\tbody, err := io.ReadAll(res.Body)', '\tif err != nil {', '\t\tfmt.Println(err)', '\t\treturn', '\t}', '\tfmt.Println(string(body))', '}')
  return out.join('\n')
}

function python(r) {
  const out = ['import requests', '']
  out.push(`url = ${py(r.url)}`, '')
  let kw = ''
  if (r.body?.mode === 'raw') {
    const pj = r.body.contentType === 'application/json' && prettyJson(r.body.raw)
    if (pj) {
      out.unshift('import json')
      out.push(`payload = json.dumps(${indent(pythonLiteral(JSON.parse(r.body.raw)), '')})`)
    } else out.push(`payload = ${py(r.body.raw)}`)
    kw = ', data=payload'
  } else if (r.body?.mode === 'urlencoded') {
    out.push('payload = {')
    for (const f of r.body.fields) out.push(`    ${py(f.key)}: ${py(f.value)},`)
    out.push('}')
    kw = ', data=payload'
  } else if (r.body?.mode === 'form-data') {
    const text = r.body.fields.filter((f) => f.type !== 'file')
    const files = r.body.fields.filter((f) => f.type === 'file')
    out.push('payload = {')
    for (const f of text) out.push(`    ${py(f.key)}: ${py(f.value)},`)
    out.push('}', 'files = [')
    for (const f of files) out.push(`    (${py(f.key)}, (${py(f.fileName)}, open(${py(f.fileName)}, "rb"))),`)
    out.push(']')
    kw = ', data=payload, files=files'
  }
  out.push('headers = {')
  for (const h of visibleHeaders(r)) out.push(`    ${py(h.key)}: ${py(h.value)},`)
  out.push('}', '', `response = requests.request(${py(r.method)}, url, headers=headers${kw})`, '', 'print(response.text)')
  return out.join('\n')
}

function pythonLiteral(v, pad = '') {
  if (v === null) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return py(v)
  const inner = pad + '    '
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    return '[\n' + v.map((x) => inner + pythonLiteral(x, inner)).join(',\n') + '\n' + pad + ']'
  }
  const keys = Object.keys(v)
  if (!keys.length) return '{}'
  return '{\n' + keys.map((k) => `${inner}${py(k)}: ${pythonLiteral(v[k], inner)}`).join(',\n') + '\n' + pad + '}'
}
