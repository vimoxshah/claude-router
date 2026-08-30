#!/usr/bin/env node
/**
 * claude-router integrity check.
 *
 * The router's behaviour is spread across seven files — five lane agents, the policy,
 * and this skill — and nothing forces them to agree. A lane whose model silently
 * unpins, a read-only lane that grows a Write tool, or a conduct rule that exists in
 * one write lane but not the other all fail the same way: a dispatch that looks fine
 * and behaves wrong. This asserts they agree, so drift surfaces here instead of
 * mid-task.
 *
 *   node $SKILLS/claude-router/validate.mjs          # check
 *   node $SKILLS/claude-router/validate.mjs --quiet   # exit code only
 *
 * Exits 0 when the definitions agree, 1 on any failure. Safe to wire into a hook.
 *
 * SCOPE — read this before trusting a green run. This checks that the definition FILES
 * agree with each other. It cannot check that Claude Code actually REGISTERED them:
 * that depends on the harness the session was launched with, and a session can be
 * given an explicit agent set that ignores ~/.claude/agents entirely. A green run here
 * plus an unregistered lane is a real state, and it was the state on 2026-08-27 — every
 * file was valid and no lane could be dispatched. Registration is proven only by
 * dispatching a lane and getting a result, never by this script.
 *
 * Adding or retiring a lane means editing LANES below and nothing else.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const AGENTS = join(HOME, '.claude', 'agents');
const SKILL = join(HOME, '.claude', 'skills', 'claude-router', 'SKILL.md');
const POLICY_GLOBAL = join(HOME, '.claude', 'CLAUDE-ROUTING.md');

/** The single declarative source of truth for what the router expects. */
const LANES = [
  { name: 'advisor',          model: 'fable',  writes: false, bash: false, role: 'Judgment' },
  { name: 'implementer',      model: 'sonnet', writes: true,  bash: true,  role: 'Build' },
  { name: 'hard-implementer', model: 'opus',   writes: true,  bash: true,  role: 'Hard build' },
  { name: 'explorer',         model: 'haiku',  writes: false, bash: true,  role: 'Volume' },
  { name: 'reviewer',         model: 'opus',   writes: false, bash: true,  role: 'Review/synth' },
];

/** Conduct rules that BOTH write lanes must carry, since the packet no longer restates them. */
const CONDUCT_MARKERS = [
  ['INTENT declaration',      'INTENT: code does <X> / check expects <Y> / spec says <Z>'],
  ['visible spec resolution', "in the spec's favor"],
  ['authority order',         'user > spec > tests > current behavior'],
  ['never weaken a check',    'Never weaken a check to make it pass'],
  ['3-cycle hard stop',       'Hard stop after 3 failed fix-verify cycles'],
  ['no debris',               'Leave no debris'],
];

/** The three-verdict vocabulary must be identical in reviewer and SKILL. */
const VERDICTS = ['VERIFIED', 'VERIFIED WITH CAVEATS', 'REFUTED'];

/** This layer is Claude-only by hard rule; these must never appear in it. */
const CODEX_LEAKS = ['codex exec', 'CLAUDE-CODEX-ROUTING', 'luna-worker', 'terra-implementer', 'sol-implementer'];

const results = [];
const pass = (m) => results.push({ level: 'ok', m });
const fail = (m, detail) => results.push({ level: 'fail', m, detail });
/** Untidy but working. Reported, never fatal — a validator that cries wolf gets ignored. */
const warn = (m, detail) => results.push({ level: 'warn', m, detail });

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function parseTools(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw.replace(/'/g, '"'));
  } catch {
    // tolerate the bare comma form: tools: Read, Grep
    return raw.split(',').map((t) => t.trim().replace(/^["'\[]|["'\]]$/g, '')).filter(Boolean);
  }
}

// ── 1. Every lane exists, parses, and is pinned to the right model ──────────────
const laneText = {};
for (const lane of LANES) {
  const p = join(AGENTS, `${lane.name}.md`);
  if (!existsSync(p)) {
    fail(`lane "${lane.name}" (${lane.role}) is missing`, p);
    continue;
  }
  const text = readFileSync(p, 'utf8');
  laneText[lane.name] = text;

  const fm = frontmatter(text);
  if (!fm) { fail(`lane "${lane.name}" has no YAML frontmatter`); continue; }

  if (fm.name !== lane.name) {
    fail(`lane "${lane.name}" frontmatter name mismatch`, `name: ${fm.name}`);
  }
  if (fm.model !== lane.model) {
    // An unpinned lane inherits the orchestrator's model AND reasoning effort — the
    // exact failure the skill warns about (a Haiku sweep burning high-effort tokens).
    fail(`lane "${lane.name}" must pin model: ${lane.model}`, `found: ${fm.model ?? '(unpinned)'}`);
  } else {
    pass(`${lane.name} → ${lane.model} (${lane.role})`);
  }
  if (!fm.description) fail(`lane "${lane.name}" has no description (it will never auto-select)`);

  // ── 2. Read-only lanes must not hold write tools ──────────────────────────────
  const tools = parseTools(fm.tools);
  if (!tools) { fail(`lane "${lane.name}" has no tools array`); continue; }
  const writeTools = tools.filter((t) => ['Edit', 'Write', 'NotebookEdit'].includes(t));
  if (!lane.writes && writeTools.length > 0) {
    fail(`read-only lane "${lane.name}" holds write tools`, writeTools.join(', '));
  }
  if (lane.writes && writeTools.length === 0) {
    fail(`write lane "${lane.name}" holds no write tools`, tools.join(', '));
  }
  if (lane.bash !== tools.includes('Bash')) {
    fail(`lane "${lane.name}" Bash expectation mismatch`, `expected ${lane.bash}, tools: ${tools.join(', ')}`);
  }
  // A read-only lane that holds Bash is only read-only by prompt — it must say so.
  if (!lane.writes && tools.includes('Bash') && !/Read-only — and that is a rule/.test(text)) {
    fail(`lane "${lane.name}" holds Bash but never states the read-only constraint`,
      'prompt is the only enforcement here — it has to be explicit');
  }
}

// ── 3. Both write lanes carry every conduct rule, identically ───────────────────
const writeLanes = LANES.filter((l) => l.writes).map((l) => l.name);
for (const [label, marker] of CONDUCT_MARKERS) {
  const missing = writeLanes.filter((n) => !laneText[n]?.includes(marker));
  if (missing.length) {
    fail(`conduct rule "${label}" missing from write lane(s)`, missing.join(', '));
  } else {
    pass(`conduct rule "${label}" present in ${writeLanes.join(' + ')}`);
  }
}

// ── 4. Verdict vocabulary agrees between reviewer and the skill ─────────────────
if (existsSync(SKILL)) {
  const skill = readFileSync(SKILL, 'utf8');
  const rev = laneText['reviewer'] ?? '';
  for (const v of VERDICTS) {
    const inSkill = skill.includes(v);
    const inRev = rev.includes(v);
    if (!inSkill || !inRev) {
      fail(`verdict "${v}" not shared`, `SKILL.md: ${inSkill ? 'yes' : 'NO'}, reviewer.md: ${inRev ? 'yes' : 'NO'}`);
    }
  }
  if (VERDICTS.every((v) => skill.includes(v) && rev.includes(v))) {
    pass(`verdict vocabulary agrees: ${VERDICTS.join(' / ')}`);
  }
  // A stale second vocabulary is worse than none — it reads as authoritative.
  if (/PASS or CHANGES-REQUIRED/.test(rev)) {
    fail('reviewer.md still carries the old PASS/CHANGES-REQUIRED vocabulary alongside the new one');
  }
} else {
  fail('SKILL.md not found', SKILL);
}

// ── 5. The policy's tier table names exactly these lanes ───────────────────────
if (existsSync(POLICY_GLOBAL)) {
  const policy = readFileSync(POLICY_GLOBAL, 'utf8');
  const missing = LANES.filter((l) => !policy.includes(`\`${l.name}\``)).map((l) => l.name);
  if (missing.length) fail('policy never mentions lane(s)', missing.join(', '));
  else pass(`policy references all ${LANES.length} lanes`);

  // ── 6. Hard rule: this layer never touches Codex ─────────────────────────────
  for (const file of [['CLAUDE-ROUTING.md', policy], ['SKILL.md', existsSync(SKILL) ? readFileSync(SKILL, 'utf8') : '']]) {
    for (const leak of CODEX_LEAKS) {
      // A mention that explicitly disclaims Codex is fine; a directive is not.
      const idx = file[1].indexOf(leak);
      if (idx === -1) continue;
      const line = file[1].slice(file[1].lastIndexOf('\n', idx) + 1, file[1].indexOf('\n', idx));
      const disclaims = /never|separate|independent|not?\s|no\s|other mechanism|distinct/i.test(line);
      if (!disclaims) fail(`possible Codex leak in ${file[0]}`, line.trim().slice(0, 120));
    }
  }
  pass('no Codex directives in the Claude-only layer');
} else {
  fail('CLAUDE-ROUTING.md not found', POLICY_GLOBAL);
}

// ── 7. Consistency of the tools syntax across ALL agents in the directory ──────
// Two frontmatter forms are in circulation (JSON array vs bare comma list). Mixing them
// in one directory means a parser change breaks an arbitrary subset — pick one.
try {
  const { readdirSync } = await import('node:fs');
  const forms = { json: [], bare: [], none: [] };
  for (const f of readdirSync(AGENTS).filter((f) => f.endsWith('.md'))) {
    const raw = readFileSync(join(AGENTS, f), 'utf8');
    const m = raw.match(/^tools:\s*(.*)$/m);
    if (!m) forms.none.push(f);
    else if (m[1].trim().startsWith('[')) forms.json.push(f);
    else forms.bare.push(f);
  }
  if (forms.json.length && forms.bare.length) {
    warn('agents directory mixes both tools: syntaxes',
      `${forms.json.length} JSON-array, ${forms.bare.length} bare-list — both register, `
      + `but one parser change would break an arbitrary subset`);
  } else {
    pass(`tools: syntax consistent across ${forms.json.length + forms.bare.length} agents`);
  }
} catch { /* directory unreadable — already reported per-lane above */ }

// ── 8. Registration reachability: is this session's config dir able to see the lanes? ──
// The failure that motivated this check: CLAUDE_CONFIG_DIR pointed at a directory with
// no agents/, so 18 valid agent files were invisible and every dispatch returned
// "Agent type not found" with no diagnostic. File validity is not registration.
{
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (!cfg || cfg === join(HOME, '.claude')) {
    pass('config dir reads ~/.claude directly — lanes are reachable');
  } else {
    const laneDir = join(cfg, 'agents');
    const reachable = LANES.every((l) => existsSync(join(laneDir, `${l.name}.md`)));
    if (reachable) {
      pass(`config dir ${cfg} reaches all ${LANES.length} lanes via agents/`);
    } else {
      fail(`CLAUDE_CONFIG_DIR=${cfg} cannot see the lanes`,
        `no ${laneDir}/<lane>.md — fix with: ~/.claude/scripts/sync-config-dir.sh "${cfg}"`);
    }
  }
}

// ── report ─────────────────────────────────────────────────────────────────────
const failures = results.filter((r) => r.level === 'fail');
const warnings = results.filter((r) => r.level === 'warn');
const quiet = process.argv.includes('--quiet');

if (!quiet) {
  for (const r of results) {
    const tag = r.level === 'ok' ? 'ok  ' : r.level === 'warn' ? 'warn' : 'FAIL';
    console.log(`  ${tag} ${r.m}${r.detail && r.level !== 'ok' ? `\n         ↳ ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(failures.length === 0
    ? `claude-router intact — ${results.length - warnings.length} passed`
      + `${warnings.length ? `, ${warnings.length} warning(s)` : ''}\n`
      + `Definitions agree and the config dir can reach them. Only an actual dispatch\n`
      + `proves the harness registered them — this session's roster is fixed at launch.`
    : `claude-router BROKEN — ${failures.length} of ${results.length} checks failed`);
}

process.exit(failures.length === 0 ? 0 : 1);
