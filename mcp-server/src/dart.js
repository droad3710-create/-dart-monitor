// OpenDART API helpers. The API key never leaves this module (errors omit URLs).

const API_BASE = "https://opendart.fss.or.kr/api/";

export const STATUS_MESSAGES = {
  "000": "정상",
  "010": "등록되지 않은 API 키",
  "011": "사용할 수 없는 API 키",
  "012": "접근할 수 없는 IP",
  "013": "조회된 데이터 없음",
  "014": "파일이 존재하지 않음",
  "020": "요청 제한 초과",
  "021": "조회 가능한 회사 개수 초과",
  "100": "필드의 부적절한 값",
  "101": "부적절한 접근",
  "800": "시스템 점검 중",
  "900": "정의되지 않은 오류",
  "901": "개인정보 보유기간 만료로 사용할 수 없는 키",
};

export class DartError extends Error {}

function buildUrl(key, endpoint, params) {
  const query = new URLSearchParams({ crtfc_key: key });
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(name, String(value));
  }
  return API_BASE + endpoint + "?" + query.toString();
}

export async function dartJson(env, endpoint, params) {
  let response;
  try {
    response = await fetch(buildUrl(env.DART_API_KEY, endpoint, params));
  } catch {
    throw new DartError(`OpenDART ${endpoint} 연결 실패`);
  }
  if (!response.ok) throw new DartError(`OpenDART ${endpoint} HTTP ${response.status}`);
  const data = await response.json();
  if (data.status !== "000" && data.status !== "013") {
    const label = STATUS_MESSAGES[data.status] || data.message || "알 수 없는 오류";
    throw new DartError(`OpenDART 오류 ${data.status}: ${label}`);
  }
  return data;
}

export async function dartBinary(env, endpoint, params) {
  let response;
  try {
    response = await fetch(buildUrl(env.DART_API_KEY, endpoint, params));
  } catch {
    throw new DartError(`OpenDART ${endpoint} 연결 실패`);
  }
  if (!response.ok) throw new DartError(`OpenDART ${endpoint} HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// ---------- ZIP (document.xml) ----------

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

export function isZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new DartError("원문 압축 파일 구조를 읽지 못했습니다.");
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (u32(bytes, p) !== 0x02014b50) break;
    const method = u16(bytes, p + 10);
    const compSize = u32(bytes, p + 20);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const start = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
    const raw = bytes.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else continue;
    files.push({ name, data });
  }
  return files;
}

// ---------- Text extraction ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeBytes(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 300));
  const match = head.match(/encoding=["']([^"']+)/i);
  const labels = [match ? match[1] : "utf-8", "utf-8"];
  for (const label of labels) {
    try {
      return new TextDecoder(label, { fatal: label !== "utf-8" }).decode(bytes);
    } catch { /* try next */ }
  }
  return new TextDecoder().decode(bytes);
}

export function htmlToText(markup) {
  return markup
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(P|TR|TABLE|TITLE|SECTION-\d|LIBRARY|BR)>|<BR\s*\/?>/gi, "\n")
    .replace(/<\/(TD|TH|TE|TU)>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (all, code) => {
      if (code[0] === "#") {
        const num = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(num) ? String.fromCodePoint(num) : all;
      }
      return ENTITIES[code.toLowerCase()] ?? all;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n[ \n|]*/g, "\n")
    .trim();
}

export function excerptAround(text, keyword, radius, limit) {
  const parts = [];
  const lower = text.toLowerCase();
  const needle = keyword.toLowerCase();
  let from = 0;
  let lastEnd = -1;
  let total = 0;
  let hits = 0;
  while (total < limit) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    hits++;
    const start = Math.max(0, at - radius);
    const end = Math.min(text.length, at + needle.length + radius);
    if (start <= lastEnd && parts.length) {
      parts[parts.length - 1] += text.slice(lastEnd, end);
    } else {
      parts.push((start > 0 ? "…" : "") + text.slice(start, end));
    }
    total += end - Math.max(start, lastEnd);
    lastEnd = end;
    from = at + needle.length;
  }
  return { hits, text: parts.join("\n…\n").slice(0, limit) };
}
