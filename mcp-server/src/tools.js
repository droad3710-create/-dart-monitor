import { dartJson, dartBinary, isZip, unzip, decodeBytes, htmlToText, excerptAround, DartError } from "./dart.js";
import { searchCompanies, resolveCorp } from "./corp-index.js";

const VIEWER = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=";

function kstDate(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function fmtDate(ymd) {
  return ymd && ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}` : ymd || "";
}

const ymdSchema = { type: "string", pattern: "^\\d{8}$" };

export const TOOLS = [
  {
    name: "search_company",
    description: "회사명으로 DART 고유번호(corp_code)를 찾는다. 상장사는 이름 일부로, 비상장사는 이름 앞부분으로 검색된다.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string", description: "회사명 또는 그 일부 (예: 현대모비스, 모비스, 현대트랜시스)" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "최대 결과 수 (기본 20)" },
      },
      required: ["company"],
    },
  },
  {
    name: "search_disclosures",
    description:
      "DART 공시 목록을 검색한다. 회사(company 또는 corp_code), 기간, 공시유형, 보고서명 키워드로 좁힐 수 있다. 회사를 지정하지 않으면 전체 시장 공시를 검색한다(이때 OpenDART는 검색 기간을 3개월 이내로 제한한다). 결과마다 접수번호(rcept_no)와 DART 원문 링크를 준다.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string", description: "회사명 (자동으로 corp_code를 찾음)" },
        corp_code: { type: "string", description: "DART 고유번호 8자리 (company보다 우선)" },
        bgn_de: { ...ymdSchema, description: "검색 시작 접수일 YYYYMMDD (기본: 회사 지정 시 90일 전, 미지정 시 7일 전)" },
        end_de: { ...ymdSchema, description: "검색 종료 접수일 YYYYMMDD (기본: 오늘, 한국 시간)" },
        pblntf_ty: {
          type: "string",
          enum: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
          description: "공시유형: A 정기공시, B 주요사항보고, C 발행공시, D 지분공시, E 기타공시, F 외부감사관련, G 펀드공시, H 자산유동화, I 거래소공시, J 공정위공시",
        },
        pblntf_detail_ty: { type: "string", description: "공시상세유형 4자리 (예: A001 사업보고서, A002 반기보고서, A003 분기보고서, B001 주요사항보고서)" },
        corp_cls: { type: "string", enum: ["Y", "K", "N", "E"], description: "법인구분: Y 유가증권, K 코스닥, N 코넥스, E 기타" },
        title_keyword: { type: "string", description: "보고서명에 포함될 키워드 (예: 공급계약, 유상증자, 최대주주). 지정하면 최대 500건을 훑어 거른다." },
        last_reprt_at: { type: "string", enum: ["Y", "N"], description: "최종보고서만 검색 여부 (기본 N)" },
        page_no: { type: "integer", minimum: 1, description: "페이지 번호 (title_keyword 없을 때)" },
        page_count: { type: "integer", minimum: 1, maximum: 100, description: "페이지당 건수 (기본 30, 최대 100)" },
      },
    },
  },
  {
    name: "get_disclosure_text",
    description:
      "접수번호(rcept_no)로 공시 원문을 받아 본문 텍스트를 돌려준다. keyword를 주면 그 단어가 나오는 부분만 앞뒤 문맥과 함께 발췌한다. 사업보고서처럼 긴 문서는 keyword를 쓰는 것이 좋다.",
    inputSchema: {
      type: "object",
      properties: {
        rcept_no: { type: "string", pattern: "^\\d{14}$", description: "접수번호 14자리" },
        keyword: { type: "string", description: "발췌할 키워드 (예: 계약금액, 현대자동차, 생산능력)" },
        max_chars: { type: "integer", minimum: 500, maximum: 40000, description: "최대 글자 수 (기본 8000)" },
        offset: { type: "integer", minimum: 0, description: "keyword 없이 읽을 때 시작 위치 (이어 읽기용)" },
      },
      required: ["rcept_no"],
    },
  },
  {
    name: "get_company_info",
    description: "기업개황: 정식 명칭, 대표자, 법인구분, 종목코드, 업종코드, 설립일, 주소, 홈페이지, 결산월.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string" },
        corp_code: { type: "string" },
      },
    },
  },
  {
    name: "get_financials",
    description:
      "정기보고서 재무제표(XBRL)에서 주요 계정을 당기·전기·전전기 금액과 증감률로 보여준다. 기본 계정: 매출액, 영업이익, 당기순이익, 자산총계, 부채총계, 자본총계. 2015년 이후 사업연도만 제공된다.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string" },
        corp_code: { type: "string" },
        bsns_year: { type: "string", pattern: "^\\d{4}$", description: "사업연도 (예: 2025)" },
        reprt_code: {
          type: "string",
          enum: ["11011", "11012", "11013", "11014"],
          description: "11011 사업보고서(기본), 11012 반기, 11013 1분기, 11014 3분기",
        },
        fs_div: { type: "string", enum: ["CFS", "OFS"], description: "CFS 연결(기본), OFS 별도" },
        accounts: { type: "array", items: { type: "string" }, description: "기본 계정 대신 볼 계정명 키워드 목록 (예: [\"연구개발비\", \"재고자산\"])" },
      },
      required: ["bsns_year"],
    },
  },
];

// ---------- handlers ----------

async function searchCompany(env, args) {
  if (!args.company) throw new DartError("company가 필요합니다.");
  const rows = await searchCompanies(env, args.company, Math.min(args.limit || 20, 50));
  if (!rows.length) return `'${args.company}'와 일치하는 회사가 없습니다.`;
  return rows.map((r) => `- ${r.corp_name} | corp_code ${r.corp_code} | ${r.listed ? "상장 " + r.stock_code : "비상장"}`).join("\n");
}

function formatRow(row) {
  const cls = { Y: "유가", K: "코스닥", N: "코넥스", E: "기타" }[row.corp_cls] || row.corp_cls;
  const remark = row.rm ? ` [비고 ${row.rm}]` : "";
  return `- ${fmtDate(row.rcept_dt)} | ${row.corp_name}(${cls}) | ${row.report_nm.trim()}${remark} | 제출인 ${row.flr_nm} | 접수번호 ${row.rcept_no} | ${VIEWER}${row.rcept_no}`;
}

async function searchDisclosures(env, args) {
  let corp = null;
  if (args.corp_code || args.company) corp = await resolveCorp(env, args);
  const base = {
    corp_code: corp?.corp_code,
    bgn_de: args.bgn_de || kstDate(corp ? -90 : -7),
    end_de: args.end_de || kstDate(0),
    pblntf_ty: args.pblntf_ty,
    pblntf_detail_ty: args.pblntf_detail_ty,
    corp_cls: args.corp_cls,
    last_reprt_at: args.last_reprt_at,
  };
  const header = `기간 ${fmtDate(base.bgn_de)}~${fmtDate(base.end_de)}${corp ? ` | 회사 ${corp.corp_name || ""}(${corp.corp_code})` : " | 전체 회사"}`;

  if (args.title_keyword) {
    const needle = args.title_keyword.replace(/\s+/g, "");
    const hits = [];
    let scanned = 0;
    let total = 0;
    for (let page = 1; page <= 5; page++) {
      const data = await dartJson(env, "list.json", { ...base, page_no: page, page_count: 100 });
      if (data.status === "013") break;
      total = data.total_count;
      scanned += data.list.length;
      for (const row of data.list) if (row.report_nm.replace(/\s+/g, "").includes(needle)) hits.push(row);
      if (page >= data.total_page) break;
    }
    const more = total > scanned ? `\n※ 전체 ${total}건 중 최근 ${scanned}건만 훑었습니다. 기간을 좁히거나 회사를 지정하세요.` : "";
    if (!hits.length) return `${header}\n보고서명에 '${args.title_keyword}'가 들어간 공시가 없습니다 (훑은 공시 ${scanned}건).${more}`;
    return `${header} | 보고서명 키워드 '${args.title_keyword}' ${hits.length}건\n${hits.map(formatRow).join("\n")}${more}`;
  }

  const data = await dartJson(env, "list.json", {
    ...base,
    page_no: args.page_no || 1,
    page_count: Math.min(args.page_count || 30, 100),
  });
  if (data.status === "013") return `${header}\n조회된 공시가 없습니다.`;
  return `${header} | 총 ${data.total_count}건 중 ${data.page_no}/${data.total_page}페이지\n${data.list.map(formatRow).join("\n")}`;
}

async function getDisclosureText(env, args) {
  if (!/^\d{14}$/.test(args.rcept_no || "")) throw new DartError("rcept_no는 14자리 숫자입니다.");
  const bytes = await dartBinary(env, "document.xml", { rcept_no: args.rcept_no });
  if (!isZip(bytes)) {
    const body = new TextDecoder().decode(bytes.subarray(0, 500));
    const status = (body.match(/<status>(\d+)<\/status>|"status"\s*:\s*"(\d+)"/) || []).slice(1).find(Boolean);
    throw new DartError(`원문을 받지 못했습니다${status ? ` (OpenDART 상태 ${status})` : ""}.`);
  }
  const files = (await unzip(bytes)).filter((f) => /\.(xml|html?)$/i.test(f.name));
  if (!files.length) throw new DartError("원문 압축 파일 안에 본문 문서가 없습니다.");
  const sections = files.map((f) => `[${f.name}]\n${htmlToText(decodeBytes(f.data))}`);
  const text = sections.join("\n\n");
  const limit = Math.min(args.max_chars || 8000, 40000);
  const head = `접수번호 ${args.rcept_no} | 원문 ${VIEWER}${args.rcept_no} | 문서 ${files.length}개, 본문 ${text.length.toLocaleString("en-US")}자`;
  if (args.keyword) {
    const { hits, text: excerpt } = excerptAround(text, args.keyword, 400, limit);
    if (!hits) return `${head}\n'${args.keyword}'는 본문에 나오지 않습니다.`;
    return `${head}\n'${args.keyword}' 발췌 (${hits}곳 이상)\n\n${excerpt}`;
  }
  const offset = args.offset || 0;
  const slice = text.slice(offset, offset + limit);
  const rest = offset + limit < text.length ? `\n\n… (이어 읽기: offset=${offset + limit})` : "";
  return `${head} | ${offset}~${offset + slice.length}자\n\n${slice}${rest}`;
}

async function getCompanyInfo(env, args) {
  const corp = await resolveCorp(env, args);
  const d = await dartJson(env, "company.json", { corp_code: corp.corp_code });
  if (d.status === "013") return "기업개황 데이터가 없습니다.";
  const cls = { Y: "유가증권", K: "코스닥", N: "코넥스", E: "기타" }[d.corp_cls] || d.corp_cls;
  return [
    `정식명칭: ${d.corp_name} (${d.corp_name_eng || "-"})`,
    `종목명/종목코드: ${d.stock_name || "-"} / ${d.stock_code || "-"}`,
    `법인구분: ${cls}`,
    `대표자: ${d.ceo_nm}`,
    `법인등록번호/사업자등록번호: ${d.jurir_no || "-"} / ${d.bizr_no || "-"}`,
    `주소: ${d.adres}`,
    `홈페이지: ${d.hm_url || "-"} | IR: ${d.ir_url || "-"}`,
    `전화: ${d.phn_no || "-"}`,
    `업종코드: ${d.induty_code}`,
    `설립일: ${fmtDate(d.est_dt)} | 결산월: ${d.acc_mt}월`,
    `DART 고유번호: ${d.corp_code}`,
  ].join("\n");
}

const DEFAULT_ACCOUNTS = [
  { label: "매출액", sj: ["IS", "CIS"], re: /^(수익\(매출액\)|매출액|영업수익|매출|수익)$/ },
  { label: "영업이익", sj: ["IS", "CIS"], re: /^영업이익(\(손실\))?$/ },
  { label: "당기순이익", sj: ["IS", "CIS"], re: /^(당기순이익|분기순이익|반기순이익)(\(손실\))?$/ },
  { label: "자산총계", sj: ["BS"], re: /^자산총계$/ },
  { label: "부채총계", sj: ["BS"], re: /^부채총계$/ },
  { label: "자본총계", sj: ["BS"], re: /^자본총계$/ },
];

function toNumber(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/,/g, "").trim();
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function eok(n) {
  return n === null ? "-" : `${(n / 1e8).toLocaleString("en-US", { maximumFractionDigits: 0 })}억원`;
}

function change(cur, prev) {
  if (cur === null || prev === null || prev === 0) return "-";
  if (prev < 0 || cur < 0) return cur >= 0 && prev < 0 ? "흑자전환" : cur < 0 && prev >= 0 ? "적자전환" : "적자지속";
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

async function getFinancials(env, args) {
  const corp = await resolveCorp(env, args);
  const reprt = args.reprt_code || "11011";
  const fs = args.fs_div || "CFS";
  const d = await dartJson(env, "fnlttSinglAcntAll.json", {
    corp_code: corp.corp_code, bsns_year: args.bsns_year, reprt_code: reprt, fs_div: fs,
  });
  const reportName = { 11011: "사업보고서", 11012: "반기보고서", 11013: "1분기보고서", 11014: "3분기보고서" }[reprt];
  const title = `${corp.corp_name || corp.corp_code} ${args.bsns_year} ${reportName} ${fs === "CFS" ? "연결" : "별도"} 재무제표`;
  if (d.status === "013") {
    return `${title}: 데이터가 없습니다.${fs === "CFS" ? " 연결 대상이 없는 회사면 fs_div=OFS로 다시 조회하세요." : ""}`;
  }
  const rows = d.list;
  const picks = [];
  if (args.accounts?.length) {
    for (const key of args.accounts) {
      const matched = rows.filter((r) => r.account_nm.replace(/\s+/g, "").includes(key.replace(/\s+/g, "")));
      if (!matched.length) picks.push({ label: key, row: null });
      for (const row of matched.slice(0, 5)) picks.push({ label: `${row.account_nm}(${row.sj_nm})`, row });
    }
  } else {
    for (const acc of DEFAULT_ACCOUNTS) {
      const row = rows.find((r) => acc.sj.includes(r.sj_div) && acc.re.test(r.account_nm.replace(/\s+/g, "")));
      picks.push({ label: acc.label, row });
    }
  }
  const sample = rows[0] || {};
  const isAnnual = reprt === "11011";
  const lines = [
    title,
    `기간: 당기 ${sample.thstrm_nm || ""} / 전기 ${sample.frmtrm_nm || ""} / 전전기 ${sample.bfefrmtrm_nm || "-"}`,
    `통화 ${sample.currency || "KRW"} | 출처 접수번호 ${sample.rcept_no || "-"} ${sample.rcept_no ? VIEWER + sample.rcept_no : ""}`,
    "",
    isAnnual ? "계정 | 당기 | 전기 | 전전기 | 전년비" : "계정 | 당기(해당 분기·반기) | 당기 누적 | 전기 | 전기 누적",
  ];
  for (const { label, row } of picks) {
    if (!row) { lines.push(`${label} | 해당 계정 없음`); continue; }
    const cur = toNumber(row.thstrm_amount);
    const prev = toNumber(row.frmtrm_amount);
    if (isAnnual) {
      lines.push(`${label} | ${eok(cur)} | ${eok(prev)} | ${eok(toNumber(row.bfefrmtrm_amount))} | ${change(cur, prev)}`);
    } else {
      lines.push(`${label} | ${eok(cur)} | ${eok(toNumber(row.thstrm_add_amount))} | ${eok(toNumber(row.frmtrm_q_amount || row.frmtrm_amount))} | ${eok(toNumber(row.frmtrm_add_amount))}`);
    }
  }
  lines.push("", "※ 금액은 원 단위 원자료를 억원으로 반올림. 재무상태표 계정의 전기는 직전 사업연도 말 기준.");
  return lines.join("\n");
}

const HANDLERS = {
  search_company: searchCompany,
  search_disclosures: searchDisclosures,
  get_disclosure_text: getDisclosureText,
  get_company_info: getCompanyInfo,
  get_financials: getFinancials,
};

export async function callTool(env, name, args) {
  const handler = HANDLERS[name];
  if (!handler) return { content: [{ type: "text", text: `알 수 없는 도구: ${name}` }], isError: true };
  try {
    const text = await handler(env, args || {});
    return { content: [{ type: "text", text }] };
  } catch (error) {
    if (!(error instanceof DartError)) console.error(name, error);
    const message = error instanceof DartError ? error.message : "서버 내부 오류가 발생했습니다.";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}
