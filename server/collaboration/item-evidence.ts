import {AppError} from '../store.js';

export type EvidenceField='refs'|'sources';

// Recognize an explicit output request, never the attachment text or the shape of a proposed answer.
export function requestedEvidenceField(request:string):EvidenceField|undefined {
  const instructions=request.replace(/(\x60{3,}|~{3,})[\s\S]*?(?:\1|$)/g,' ')
    .replace(/^[\t ]*>[^\n]*$/gm,' ')
    .replace(/(?:示例|举例|例如|example|样例)[：:][^\n]*(?:\n[^\n]+)*/gi,' ')
    .replace(/“(?!refs”|sources”)[^”]*”|「[^」]*」|『[^』]*』|["\x60][^"\x60\n]*(?:请|return|output|deliver)[^"\x60\n]*["\x60]/gi,' ');
  const directives=instructions.split(/[。！!？?；;\n]/).map(s=>s.trim());
  const output=/(?:交付|输出|返回|生成|给出|整理为|格式(?:为|是|要求)|return\b|output\b|deliver\b|provide\b)[^。\n]{0,55}?\bJSON\s*(?:数组|array\b)/i;
  for(let i=0;i<directives.length;i++) {
    const directive=directives[i]!;
    if(/(?:举例|例如|示例|转述|转达|引述|对方说|原文说|假设|是否|the example|quote says|what if)/i.test(directive) || !output.test(directive) || /(?:不用|无需|不必|不要|别|do not|don't)[^，,]{0,16}(?:JSON|交付|输出|返回|生成|return|output|deliver)/i.test(directive))continue;
    const fields=directive+' '+(directives[i+1]??'');
    if(!/(?:每(?:一)?(?:条|项|行|个对象)|逐(?:条|项|行)|each (?:item|row|entry|object))/i.test(fields))continue;
    const matches=[...fields.matchAll(/\b(refs|sources)\b\s*[`”"'：:(（=\s]*([^）);；。\n]{1,95})/gi)];
    for(const match of matches){
      if(match[1]!==match[1]!.toLowerCase() || /(?:可选|选填|可为空|允许为空|optional|may be empty)/i.test(fields.slice(match.index!)))continue;
      const explanation=match[2]!.split(/[,，]/)[0]!;
      if(/(?:回执|凭据|材料|原件|来源|依据|原始记录|证据|receipt|record|document|source|evidence)/i.test(explanation) &&
        /(?:编号|标识|\bIDs?\b|identifiers?)/i.test(explanation) &&
        /(?:数组|列表|集合|array|list)/i.test(explanation))return match[1]!.toLowerCase() as EvidenceField;
    }
  }
}

function reject(message:string):never {
  throw new AppError(422,message+' 请修正后再次提交；若确实缺少相关记录，只传 obligationId 和 missingEvidence 说明缺口。','invalid_item_evidence');
}

function recordIds(materials:string[]) {
  const ids=new Set<string>();
  // Unlabelled prose, dates, times and URLs do not declare record identities. At a record's
  // start allow conventional segmented alphanumeric keys or UUIDs. Explicit labels can
  // also name numeric or non-Latin IDs without changing the domain contract.
  for(const material of materials) {
    for(const line of material.split(/\r?\n/)){
      const listed=/^\s*(?:[-*]\s+)?[\[【]?([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*)[\]】]?(?=[\t |｜：]|:\s|$)/.exec(line)?.[1];
      if(listed && listed.length<=128 && /\d/.test(listed) && /[a-z]/i.test(listed) && !/^\d{4}-\d\d-\d\dT/i.test(listed))ids.add(listed);
    }
    for(const m of material.matchAll(/(?:回执|凭据|记录|材料|工单|原件)?(?:编号|标识)|\b(?:record|receipt|document|evidence)\s+(?:ID|identifier)\b/gi)){
      const at=m.index!+m[0].length;
      const value=/^[\t ]*(?:[：:=#][\t ]*|[\t ]+)([\p{L}\d]+(?:[-_][\p{L}\d]+)*)(?=[\t \r\n，,。；;|｜）)]|$)/u.exec(material.slice(at,at+160))?.[1];
      if(value && value.length<=128 && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(value))ids.add(value);
    }
  }
  return ids;
}

export function checkItemEvidence(body:string,field:EvidenceField,materials:string[]) {
  let rows:unknown;
  try {rows=JSON.parse(body);} catch {reject('请交付可直接解析的 JSON 数组。');}
  if(!Array.isArray(rows) || rows.length===0)reject('逐项证据表至少需要一行。');
  const tokens=recordIds(materials);
  for(const [i,row] of rows.entries()) {
    const refs=row && typeof row==='object' && !Array.isArray(row)?row[field]:undefined;
    if(!Array.isArray(refs) || !refs.length)reject('第 '+(i+1)+' 行缺少 '+field+' 引用。可引用明确限制对象或用途的原始记录，解释该项为何仍待核实。');
    if(refs.some(ref=>typeof ref!=='string'||!tokens.has(ref)))reject('第 '+(i+1)+' 行含有无法在原委托及其可读文本附件中核对的完整编号。');
  }
}
