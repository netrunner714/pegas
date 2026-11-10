import fs from 'node:fs/promises';
import path from 'node:path';

import { stripSource } from './nextjs-audit.js';

// Детектор ветвлений по среде: доктрина Pegas.
// Рид-онли, ноль зависимостей, по образцу nextjs-audit.ts.
// Флаги: ветвление по NODE_ENV, PEGAS_ENV, PEGAS_SCENARIO в той же строке,
// где есть if, switch, сравнение или тернарник; любое чтение PORT, HOST,
// APP_DOMAIN, CLIENT_ORIGINS. Не флаги: чтение сценария для логов,
// упоминания в комментариях и строках, тесты.

export type EnvBranchKind = 'branch' | 'banned-key';

export interface EnvBranchIssue {
  file: string;
  line: number;
  kind: EnvBranchKind;
  key: string;
  snippet: string;
}

export interface EnvBranchFinding {
  status: 'ok' | 'found';
  issues: EnvBranchIssue[];
  totalIssues: number;
  filesScanned: number;
  warning: string | null;
}

const NL = String.fromCharCode(10);
const ENV_BRANCH_KEYS = new Set(['NODE_ENV', 'PEGAS_ENV', 'PEGAS_SCENARIO']);
const BANNED_KEYS = new Set(['PORT', 'HOST', 'APP_DOMAIN', 'CLIENT_ORIGINS']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.pegas', 'dist', 'build', '.next', '.cache', 'coverage', '.turbo', 'out', '.vercel']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const MAX_ISSUES = 20;
const MAX_LISTED = 5;

function isIdent(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_';
}

function lineAt(code: string, index: number): { text: string; line: number } {
  const before = code.slice(0, index);
  const line = before.split(NL).length;
  const start = before.lastIndexOf(NL) + 1;
  const end = code.indexOf(NL, index);
  const text = code.slice(start, end === -1 ? code.length : end).trim();
  return { text, line };
}

function isBranch(lineText: string): boolean {
  if (lineText.includes('if ') || lineText.includes('if(') || lineText.includes('switch') || lineText.includes('case ')) return true;
  if (lineText.includes('===') || lineText.includes('!==') || lineText.includes('==') || lineText.includes('!=')) return true;
  return lineText.includes('?') && lineText.includes(':');
}

export function findEnvBranches(source: string, file = '<inline>'): EnvBranchIssue[] {
  const stripped = stripSource(source);
  const code = stripped.code;
  const inString = stripped.inString;
  const issues: EnvBranchIssue[] = [];
  let pos = 0;
  while (pos < code.length) {
    const proc = code.indexOf('process.env', pos);
    const bun = code.indexOf('Bun.env', pos);
    let idx = -1;
    let len = 0;
    if (proc === -1) { idx = bun; len = 7; }
    else if (bun === -1) { idx = proc; len = 11; }
    else if (proc < bun) { idx = proc; len = 11; }
    else { idx = bun; len = 7; }
    if (idx === -1) break;
    const prev = idx > 0 ? code[idx - 1] : '';
    if (isIdent(prev) || prev === '.' || prev === '$') { pos = idx + len; continue; }
    if (inString[idx]) { pos = idx + len; continue; }
    const after = idx + len;
    let key = '';
    let nextPos = after + 1;
    if (code[after] === '.') {
      let end = after + 1;
      while (end < code.length && isIdent(code[end])) end++;
      key = code.slice(after + 1, end);
      nextPos = end;
    } else if (code[after] === '[') {
      let p = after + 1;
      while (p < code.length && (code.charCodeAt(p) === 32 || code.charCodeAt(p) === 9)) p++;
      const q = code.charCodeAt(p);
      if (q !== 34 && q !== 39) { pos = after + 1; continue; }
      const endQuote = code.indexOf(String.fromCharCode(q), p + 1);
      if (endQuote === -1) { pos = after + 1; continue; }
      key = code.slice(p + 1, endQuote);
      nextPos = endQuote + 1;
    } else { pos = after + 1; continue; }
    if (!key) { pos = nextPos; continue; }
    pos = nextPos;
    const found = lineAt(code, idx);
    const text = found.text;
    const line = found.line;
    if (BANNED_KEYS.has(key)) {
      issues.push({ file, line, kind: 'banned-key', key, snippet: text.slice(0, 120) });
    } else if (ENV_BRANCH_KEYS.has(key)) {
      if (!isBranch(text)) continue;
      issues.push({ file, line, kind: 'branch', key, snippet: text.slice(0, 120) });
    }
  }
  return issues;
}

async function collect(dir: string, out: string[]): Promise<void> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name === '__tests__') continue;
      await collect(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      if (!SOURCE_EXTS.has(path.extname(e.name))) continue;
      if (e.name.includes('.test.')) continue;
      if (e.name.includes('.spec.')) continue;
      out.push(path.join(dir, e.name));
    }
  }
}

function buildWarning(issues: EnvBranchIssue[], total: number): string {
  const listed = issues.slice(0, MAX_LISTED).map((i) => i.file + ':' + i.line + ' — ' + i.snippet).join(NL + '  ');
  const word = total === 1 ? 'находка' : total < 5 ? 'находки' : 'находок';
  return 'Ветвления по среде в коде: ' + total + ' ' + word + ' — сценарий — флаг запуска, код читает готовые значения через runtime: currentService().scenario — только для логов и меток, config(KEY) — для конфига из services.env, secret() — для секретов, currentService().port и services() — вместо process.env.PORT и HOST.' + NL + '  ' + listed + (total > MAX_LISTED ? NL + '  …и ещё ' + (total - MAX_LISTED) : '');
}

export async function auditEnvBranches(projectRoot: string): Promise<EnvBranchFinding> {
  const files: string[] = [];
  await collect(projectRoot, files);
  const all: EnvBranchIssue[] = [];
  for (const file of files) {
    let source: string;
    try { source = await fs.readFile(file, 'utf-8'); } catch { continue; }
    const rel = path.relative(projectRoot, file).split(path.sep).join('/');
    const found = findEnvBranches(source, rel);
    for (const item of found) all.push(item);
  }
  all.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const totalIssues = all.length;
  const issues = all.slice(0, MAX_ISSUES);
  return { status: totalIssues === 0 ? 'ok' : 'found', issues, totalIssues, filesScanned: files.length, warning: totalIssues === 0 ? null : buildWarning(issues, totalIssues) };
}
