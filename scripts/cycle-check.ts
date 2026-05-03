#!/usr/bin/env -S npx tsx
/**
 * cycle-check.ts — Tarjan's SCC on a CFN template.
 *
 * [Engineer-Principal · Opus · run-round8-pre-deploy-validation]
 *
 * Purpose:
 *   CFN provisions resources concurrently and infers ordering from Refs/GetAtts/
 *   DependsOn. If those references form a cycle (SCC > 1), CloudFormation will
 *   refuse to deploy the stack with "Circular dependency between resources".
 *
 *   This script statically detects that case from the synthesized template
 *   BEFORE the operator runs `cdk deploy` (~25 min of wasted time per cycle).
 *
 * Inputs:
 *   argv[2] = absolute path to the CFN template JSON
 *
 * Outputs (stdout):
 *   On success: `OK: 0 cycles in N resources`
 *   On failure: pretty-prints each cycle (resource list)
 *
 * Exit code:
 *   0 = no cycle
 *   1 = at least one cycle
 *   2 = invalid input (missing path, malformed JSON)
 *
 * Algorithm:
 *   - Build directed graph: Resources[i] depends on every other resource it
 *     references via Ref, Fn::GetAtt, or DependsOn (string or array).
 *   - Run Tarjan's strongly-connected-components algorithm.
 *   - Any SCC with size > 1 is a cycle. (Self-loops with size = 1 also count
 *     as cycles per CFN's interpretation, but CDK never emits a self-loop so
 *     we treat size=1 + self-edge as a cycle for completeness.)
 *
 * Why not just use `cdk synth`?
 *   CDK's own cycle detector lives in synth time and uses the construct tree,
 *   not the CFN-level Refs graph. Some cycles only appear after CFN-parse
 *   resolution (e.g. a CfnRef inside a JSON property that's only stringified
 *   late). Re-checking the template post-synth catches both.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

interface Template {
  Resources?: Record<string, ResourceDef>
  [k: string]: unknown
}

interface ResourceDef {
  Type?: string
  Properties?: unknown
  DependsOn?: string | string[]
  [k: string]: unknown
}

/**
 * Recursively walk a value collecting referenced logical ids.
 * Honors:
 *   - { Ref: "<resourceId>" }
 *   - { "Fn::GetAtt": "<resourceId>.<attr>" }
 *   - { "Fn::GetAtt": ["<resourceId>", "<attr>"] }
 *   - { "Fn::Sub": "...${resourceId}..." }
 *   - { "Fn::Sub": ["...${resourceId}...", { ... }] }
 *
 * Refs to AWS pseudo parameters (e.g. AWS::Region, AWS::AccountId) are ignored.
 * Refs to parameters / mappings are also ignored (only same-template resources matter).
 */
function collectRefs(value: unknown, knownResources: Set<string>, out: Set<string>): void {
  if (value === null || value === undefined) return

  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, knownResources, out)
    return
  }

  if (typeof value !== 'object') return

  const obj = value as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    const v = obj[key]

    if (key === 'Ref' && typeof v === 'string') {
      if (knownResources.has(v)) out.add(v)
      continue
    }

    if (key === 'Fn::GetAtt') {
      let target: string | undefined
      if (typeof v === 'string') {
        target = v.split('.')[0]
      } else if (Array.isArray(v) && v.length >= 1 && typeof v[0] === 'string') {
        target = v[0]
      }
      if (target && knownResources.has(target)) out.add(target)
      continue
    }

    if (key === 'Fn::Sub') {
      let template: string | undefined
      let varBag: Record<string, unknown> | undefined
      if (typeof v === 'string') {
        template = v
      } else if (Array.isArray(v) && v.length >= 1 && typeof v[0] === 'string') {
        template = v[0]
        if (v.length >= 2 && typeof v[1] === 'object' && v[1] !== null) {
          varBag = v[1] as Record<string, unknown>
        }
      }
      if (template) {
        // Match ${LogicalId} or ${LogicalId.Attr}; skip ${!Literal} escape.
        const re = /\$\{([^}!][^}]*)\}/g
        let m: RegExpExecArray | null
        while ((m = re.exec(template)) !== null) {
          const refName = m[1].split('.')[0]
          // If varBag overrides this name, skip (it's a literal, not a Ref)
          if (varBag && Object.prototype.hasOwnProperty.call(varBag, refName)) continue
          if (knownResources.has(refName)) out.add(refName)
        }
        // Walk the var-bag for embedded Refs/GetAtts
        if (varBag) collectRefs(varBag, knownResources, out)
      }
      continue
    }

    // Recurse into nested structures (and Fn::* we don't special-case)
    collectRefs(v, knownResources, out)
  }
}

/**
 * Build the dependency adjacency list.
 * `graph[u]` is the set of resources `u` depends on (edges u -> v means
 * "u needs v to be created first"). For SCC detection direction is
 * irrelevant, but downstream tools may want consistent semantics.
 */
function buildGraph(resources: Record<string, ResourceDef>): Map<string, Set<string>> {
  const knownResources = new Set(Object.keys(resources))
  const graph = new Map<string, Set<string>>()

  for (const [id, def] of Object.entries(resources)) {
    const deps = new Set<string>()
    collectRefs(def.Properties, knownResources, deps)
    collectRefs(def.Metadata, knownResources, deps)

    // Explicit DependsOn
    if (typeof def.DependsOn === 'string') {
      if (knownResources.has(def.DependsOn)) deps.add(def.DependsOn)
    } else if (Array.isArray(def.DependsOn)) {
      for (const d of def.DependsOn) {
        if (typeof d === 'string' && knownResources.has(d)) deps.add(d)
      }
    }

    // Self-edges are valid in graphs but not in CFN; flag them as cycles below.
    graph.set(id, deps)
  }

  return graph
}

/**
 * Tarjan's strongly-connected-components algorithm (iterative — avoids
 * call-stack overflow on large CDK templates with hundreds of resources).
 *
 * Returns a list of SCCs; each SCC is a list of resource ids.
 */
function tarjan(graph: Map<string, Set<string>>): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const lowlinks = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []

  // Iterative DFS state per node
  type Frame = { node: string; iter: Iterator<string>; pendingChild?: string }
  const callStack: Frame[] = []

  for (const start of graph.keys()) {
    if (indices.has(start)) continue

    callStack.push({ node: start, iter: graph.get(start)!.values() })
    indices.set(start, index)
    lowlinks.set(start, index)
    index++
    stack.push(start)
    onStack.add(start)

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]

      // Resume after recursive child (update lowlink)
      if (frame.pendingChild !== undefined) {
        const child = frame.pendingChild
        frame.pendingChild = undefined
        lowlinks.set(frame.node, Math.min(lowlinks.get(frame.node)!, lowlinks.get(child)!))
      }

      const next = frame.iter.next()
      if (next.done) {
        // All children processed; check if this is a root of an SCC
        if (lowlinks.get(frame.node) === indices.get(frame.node)) {
          const scc: string[] = []
          while (stack.length > 0) {
            const w = stack.pop()!
            onStack.delete(w)
            scc.push(w)
            if (w === frame.node) break
          }
          sccs.push(scc)
        }
        callStack.pop()
        // Bubble lowlink up to caller via pendingChild
        if (callStack.length > 0) {
          callStack[callStack.length - 1].pendingChild = frame.node
        }
        continue
      }

      const child = next.value
      if (!indices.has(child)) {
        indices.set(child, index)
        lowlinks.set(child, index)
        index++
        stack.push(child)
        onStack.add(child)
        callStack.push({ node: child, iter: graph.get(child)!.values() })
      } else if (onStack.has(child)) {
        lowlinks.set(frame.node, Math.min(lowlinks.get(frame.node)!, indices.get(child)!))
      }
    }
  }

  return sccs
}

/**
 * Identify cycles. An SCC is a cycle if either:
 *   - It contains > 1 node (mutual reference), OR
 *   - It contains exactly 1 node which references itself.
 */
function findCycles(graph: Map<string, Set<string>>): string[][] {
  const sccs = tarjan(graph)
  return sccs.filter((scc) => {
    if (scc.length > 1) return true
    const only = scc[0]
    return graph.get(only)?.has(only) ?? false
  })
}

function main(): number {
  const path = process.argv[2]
  if (!path) {
    process.stderr.write('usage: cycle-check.ts <template.json>\n')
    return 2
  }

  const abs = resolve(process.cwd(), path)
  if (!existsSync(abs)) {
    process.stderr.write(`error: file not found: ${abs}\n`)
    return 2
  }

  let raw: string
  try {
    raw = readFileSync(abs, 'utf8')
  } catch (err) {
    process.stderr.write(`error: cannot read file: ${(err as Error).message}\n`)
    return 2
  }

  let template: Template
  try {
    template = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(`error: invalid JSON: ${(err as Error).message}\n`)
    return 2
  }

  const resources = template.Resources ?? {}
  const ids = Object.keys(resources)
  if (ids.length === 0) {
    process.stdout.write('OK: 0 cycles (template has no Resources)\n')
    return 0
  }

  const graph = buildGraph(resources)
  const cycles = findCycles(graph)

  if (cycles.length === 0) {
    process.stdout.write(`OK: 0 cycles in ${ids.length} resources\n`)
    return 0
  }

  process.stderr.write(
    `FAIL: ${cycles.length} cycle(s) detected in ${ids.length} resources\n\n`,
  )
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i]
    process.stderr.write(`  cycle ${i + 1}: ${cycle.length} resource(s)\n`)
    for (const r of cycle) {
      const deps = [...(graph.get(r) ?? [])].filter((d) => cycle.includes(d))
      process.stderr.write(`    - ${r} -> [${deps.join(', ')}]\n`)
    }
    process.stderr.write('\n')
  }
  return 1
}

const code = main()
process.exit(code)
