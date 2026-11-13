import {AppError} from '../store.js';

export type EvidenceField='refs'|'sources';

// Recognize an explicit output request, never the attachment text or the shape of a proposed answer.
function requestInstructions(request:string) {
  return request.replace(/(\x60{3,}|~{3,})[\s\S]*?(?:\1|$)/g,' ')
    .replace(/^[\t ]*>[^\n]*$/gm,' ')
    .replace(/(?:示例|举例|例如|example|样例)[：:][^\n]*(?:\n[^\n]+)*/gi,' ')
    .replace(/“(?!refs”|sources”)[^”]*”|「[^」]*」|『[^』]*』|["\x60][^"\x60\n]*(?:请|return|output|deliver)[^"\x60\n]*["\x60]/gi,' ');
}

export function requestedEvidenceField(request:string):EvidenceField|undefined {
  const directives=requestInstructions(request).split(/[。！!？?；;\n]/).map(s=>s.trim());
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

// Parse a declaration like item（上述项目名） or item = the names listed below.
// A bare item field, an example, or a request for descriptions has no name contract.
function nameDirection(instruction:string):'above'|'below'|undefined {
  const fields=[...instruction.matchAll(/(?:^|[^\w.])['"\x60]?item['"\x60]?\s*(?:[（(=:：]|\bis\b)\s*([^，,。;；)）\n]+)/g)];
  if(fields.length!==1)return;
  const meaning=fields[0]![1]!.trim();
  const cn=/^(?:原样使用|填写|使用|采用|为|取)?(?:与)?(上述|上列|上文|前述|以上|下列|下文|以下)的?(?:(?:项目|事项|条目|任务|条款)(?:名称|短名|名)|(?:短名|标签))(?:一致)?$/u.exec(meaning);
  if(cn)return /下/.test(cn[1]!)?'below':'above';
  return /^(?:the )?(?:exact )?(?:item |project |entry |row )?(?:names?|labels?) (?:listed |given )?(above|below)$/i.exec(meaning)?.[1]?.toLowerCase() as 'above'|'below'|undefined;
}

export function requestedItemNames(request:string):string[]|undefined {
  const lines=requestInstructions(request.replace(/“item”/g,'item')).split(/\r?\n/).map(s=>s.trim());
  const directives=lines.flatMap((line,i)=>{
    if(!requestedEvidenceField(line+'\n'+(lines[i+1]??'')))return [];
    // Do not treat a field in the preceding or following unrelated sentence as a schema.
    const clauses=line.split(/[。！!？?；;]/);
    for(let j=0;j<clauses.length;j++){
      const out=clauses[j]!;
      if(!/\bJSON\s*(?:数组|array\b)/i.test(out))continue;
      const continuation=clauses[j+1]?.trim() || lines[i+1] || '';
      const schema=/(?:每(?:一)?(?:条|项|行|个对象)|逐(?:条|项|行)|each (?:item|row|entry|object))/i.test(out) ? out :
        out+'。'+continuation;
      const direction=nameDirection(schema);
      if(direction && requestedEvidenceField(schema))return [{index:i,direction}];
    }
    return [];
  });
  if(directives.length!==1)return;
  const {index,direction}=directives[0]!;
  const entry=/^(?:[-*•]\s+|\d{1,3}[.、)]\s*)?([\p{L}\p{N}][\p{L}\p{M}\p{N} _.·&+\-/]{0,63}?)\s*[：:]\s*\S/u;
  const groups:{start:number;end:number;names:string[]}[]=[];
  let names:string[]=[];
  for(let i=0;i<=lines.length;i++){
    const name=entry.exec(lines[i]??'')?.[1];
    if(name){
      names.push(name);
    }else if(names.length){
      groups.push({start:i-names.length,end:i-1,names});
      names=[];
    }
  }
  if(groups.length!==1)return;
  const list=groups[0]!;
  if(direction==='above' ? list.end>=index : list.start<=index)return;
  if(list.names.length<2 || new Set(list.names).size!==list.names.length)return;
  // A malformed adjacent entry could belong to this same list. Never freeze a partial list.
  const adjacent=[lines[list.start-1],lines[list.end+1]];
  if(adjacent.some(line=>line && !line.includes('JSON') &&
    (/^\s*(?:[-*•]|\d+[.、)])/.test(line) || /^[^。.!?！？]{1,80}[：:]\s*\S/.test(line))))return;
  return list.names;
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

export function checkItemEvidence(body:string,field:EvidenceField,materials:string[],itemNames?:readonly string[]) {
  let rows:unknown;
  try {rows=JSON.parse(body);} catch {reject('请交付可直接解析的 JSON 数组。');}
  if(!Array.isArray(rows))reject('请交付可直接解析的 JSON 数组。');
  if(itemNames){
    const expected=new Set(itemNames);
    const received=new Set<string>();
    function nameError(detail:string):never {
      throw new AppError(422,detail+' 原委托要求的 item 短名是 '+JSON.stringify(itemNames)+'；请逐字填写，每项恰好一行，然后重新提交。','invalid_item_names');
    }
    for(const [i,row] of rows.entries()){
      if(!row || typeof row.item!=='string' || !expected.has(row.item))
        nameError('第 '+(i+1)+' 行 item 缺失或与原文短名不符。');
      if(received.has(row.item))nameError('第 '+(i+1)+' 行重复了 '+JSON.stringify(row.item)+'。');
      received.add(row.item);
    }
    const missing=itemNames.filter(name=>!received.has(name));
    if(missing.length)nameError('缺少 '+JSON.stringify(missing)+'。');
  }
  if(!rows.length)reject('逐项证据表至少需要一行。');
  const tokens=recordIds(materials);
  for(const [i,row] of rows.entries()) {
    const refs=row && typeof row==='object' && !Array.isArray(row)?row[field]:undefined;
    if(!Array.isArray(refs) || !refs.length)reject('第 '+(i+1)+' 行缺少 '+field+' 引用。可引用明确限制对象或用途的原始记录，解释该项为何仍待核实。');
    if(refs.some(ref=>typeof ref!=='string'||!tokens.has(ref)))reject('第 '+(i+1)+' 行含有无法在原委托及其可读文本附件中核对的完整编号。');
  }
}
