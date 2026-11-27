// Company name -> DART corp_code lookup, backed by small TSV files that the
// "DART 회사코드 인덱스" GitHub Actions workflow builds from corpCode.xml.
//   listed.tsv      : every listed company (substring search)
//   all/NN.tsv      : every company, sharded by first character (prefix search)
// Row format: corp_code \t corp_name \t stock_code \t normalized_name

import { DartError } from "./dart.js";

export const SHARDS = 64;
const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

export function normalizeName(name) {
  return name
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function shardOf(normalized) {
  return String(normalized.codePointAt(0) % SHARDS).padStart(2, "0");
}

async function loadFile(env, path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const base = (env.INDEX_BASE || "").replace(/\/?$/, "/");
  let response;
  try {
    response = await fetch(base + path);
  } catch {
    throw new DartError("회사코드 인덱스에 연결하지 못했습니다.");
  }
  if (response.status === 404) {
    cache.set(path, { at: Date.now(), rows: [] });
    return [];
  }
  if (!response.ok) throw new DartError(`회사코드 인덱스 HTTP ${response.status}`);
  const rows = (await response.text()).split("\n").filter(Boolean).map((line) => {
    const [corp_code, corp_name, stock_code, norm] = line.split("\t");
    return { corp_code, corp_name, stock_code: stock_code || "", norm: norm || normalizeName(corp_name) };
  });
  cache.set(path, { at: Date.now(), rows });
  return rows;
}

export async function searchCompanies(env, query, limit = 20) {
  const q = normalizeName(query);
  if (!q) return [];
  const [listed, shard] = await Promise.all([
    loadFile(env, "listed.tsv"),
    loadFile(env, `all/${shardOf(q)}.tsv`),
  ]);
  const found = new Map();
  for (const row of listed) if (row.norm.includes(q)) found.set(row.corp_code, row);
  for (const row of shard) if (row.norm.startsWith(q) && !found.has(row.corp_code)) found.set(row.corp_code, row);
  const score = (row) =>
    (row.norm === q ? 0 : 100) + (row.stock_code ? 0 : 50) + (row.norm.startsWith(q) ? 0 : 20) + row.norm.length;
  return [...found.values()].sort((a, b) => score(a) - score(b)).slice(0, limit)
    .map(({ corp_code, corp_name, stock_code }) => ({ corp_code, corp_name, stock_code, listed: Boolean(stock_code) }));
}

export async function resolveCorp(env, { corp_code, company }) {
  if (corp_code) {
    if (!/^\d{8}$/.test(corp_code)) throw new DartError("corp_code는 8자리 숫자입니다.");
    return { corp_code, corp_name: company || "" };
  }
  if (!company) throw new DartError("company(회사명) 또는 corp_code 중 하나가 필요합니다.");
  const matches = await searchCompanies(env, company, 10);
  if (!matches.length) throw new DartError(`'${company}'와 일치하는 회사를 찾지 못했습니다. search_company로 이름을 확인하세요.`);
  const q = normalizeName(company);
  const exact = matches.filter((m) => normalizeName(m.corp_name) === q);
  const pick = exact.length === 1 ? exact[0]
    : exact.length > 1 ? (exact.filter((m) => m.listed).length === 1 ? exact.find((m) => m.listed) : null)
    : matches.length === 1 ? matches[0] : null;
  if (!pick) {
    const list = matches.map((m) => `${m.corp_name}(${m.corp_code}${m.stock_code ? ", " + m.stock_code : ""})`).join(", ");
    throw new DartError(`'${company}' 후보가 여러 개입니다. corp_code로 다시 지정하세요: ${list}`);
  }
  return pick;
}
