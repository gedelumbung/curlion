// GraphQL helpers: schema introspection and a compact schema summary for the explorer.

export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind name description
      fields(includeDeprecated: true) {
        name description isDeprecated
        args { name description type { ...TypeRef } defaultValue }
        type { ...TypeRef }
      }
      inputFields { name description type { ...TypeRef } defaultValue }
      enumValues(includeDeprecated: true) { name description }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
}`

/** "[User!]!" style rendering of an introspected type reference. */
export function typeName(t) {
  if (!t) return ''
  if (t.kind === 'NON_NULL') return `${typeName(t.ofType)}!`
  if (t.kind === 'LIST') return `[${typeName(t.ofType)}]`
  return t.name
}

/** Innermost named type of a reference (for navigation). */
export const baseType = (t) => (t?.ofType ? baseType(t.ofType) : t?.name)

/**
 * Turn an introspection result into { roots: [{ kind, typeName, fields }], types: Map }.
 * Throws when the response is not an introspection result.
 */
export function summarizeSchema(json) {
  const schema = json?.data?.__schema
  if (!schema) throw new Error(json?.errors?.[0]?.message || 'The response is not a GraphQL introspection result (introspection may be disabled).')
  const types = new Map(schema.types.filter((t) => !t.name.startsWith('__')).map((t) => [t.name, t]))
  const roots = [
    ['query', schema.queryType?.name],
    ['mutation', schema.mutationType?.name],
    ['subscription', schema.subscriptionType?.name],
  ]
    .filter(([, name]) => name && types.get(name))
    .map(([kind, name]) => ({ kind, typeName: name, fields: types.get(name).fields || [] }))
  return { roots, types }
}

/** A starter operation for a root field, selecting scalar fields one level deep. */
export function operationFor(kind, field, types) {
  const args = field.args || []
  const varDefs = args.map((a) => `$${a.name}: ${typeName(a.type)}`).join(', ')
  const callArgs = args.map((a) => `${a.name}: $${a.name}`).join(', ')
  const t = types.get(baseType(field.type))
  let selection = ''
  if (t && (t.kind === 'OBJECT' || t.kind === 'INTERFACE')) {
    const scalars = (t.fields || []).filter((f) => {
      const k = types.get(baseType(f.type))?.kind
      return (k === 'SCALAR' || k === 'ENUM') && !(f.args || []).some((a) => a.type.kind === 'NON_NULL')
    })
    const picked = (scalars.length ? scalars : (t.fields || []).slice(0, 1)).slice(0, 12)
    selection = ` {\n${picked.map((f) => `    ${f.name}`).join('\n')}\n  }`
  }
  const name = field.name.charAt(0).toUpperCase() + field.name.slice(1)
  return `${kind} ${name}${varDefs ? `(${varDefs})` : ''} {\n  ${field.name}${callArgs ? `(${callArgs})` : ''}${selection}\n}\n`
}

/** Variables JSON skeleton for an operation's arguments. */
export function variablesFor(field) {
  const out = {}
  for (const a of field.args || []) out[a.name] = null
  return Object.keys(out).length ? JSON.stringify(out, null, 2) : ''
}
