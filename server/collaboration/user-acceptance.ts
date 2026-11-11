/** Interpret direct instructions reserving final approval. Missing or ambiguous terms retain normal delivery. */
const humanApproval = /(?:(?:提交|交付|交|留给|发给)(?:给|由)?我(?:本人|亲自|来|做)?(?:最终)?(?:验收|签收|审批|批准)|(?:必须|需要|等到|等待|等|待|请|让|由)我(?:本人|亲自|来|做)?(?:最终)?(?:验收|签收|审批|批准)|我(?:本人|亲自|来|要亲自|会亲自|需要亲自|负责)(?:最终)?(?:验收|签收|审批|批准)|(?:等到|等待|等|待)我(?:本人|亲自|最终)?确认(?:通过)?(?:后|再)(?:再|才能|才可|方可|可以)?(?:关闭|结束|完成交付|结案)|\b(?:wait for|require|obtain|submit(?:\s+.{1,50}?)?\s+for)\s+my\s+(?:(?:explicit|personal|final|formal)\s+)*(?:approval|acceptance|sign[- ]off|confirmation)\b|\b(?:send|submit|return|give)\s+(?:.{1,45}?\s+)?(?:to\s+)?me\s+for\s+(?:(?:my|final|explicit|personal)\s+)*(?:approval|acceptance|sign[- ]off)\b|\bI\s+(?:will personally|want to personally|must|will)\s+(?:approve|sign off on|accept)\s+(?:the|your|this)\s+(?:final\s+)?(?:result|work|delivery|deliverable)\b)/iu;
const reservedUntilApproval = /(?:未经我(?:本人|亲自)?(?:验收|确认|批准|签收|审批)[，,\s]*(?:不要|不得|不能|不可)(?:关闭|结束|交付|结案)|\b(?:do not|don't|don’t|never)\s+(?:close|finish|deliver|finalize)\b[^.!?\n;]{0,45}\buntil I (?:personally )?(?:approve|sign off on|accept)(?: the final (?:result|delivery|deliverable))?\b)/iu;
const disqualifier = /(?:不必|不用|不需要|无需|无须|不要|不得|禁止|不应|别|跳过|省略|免去|取消|并非|不是|是否|如果|假如|假设|可能|抄送|转述|声称|表述|\b(?:not|never|without|unless|if|cc|skip|hypothetically)\b|n['’]t\b|\bno\s+(?:need|approval|requirement)\b)/iu;
const exampleOrAttribution = /(?:示例|举例|例如|比如|样例|模板|转述|转达|原话|(?:说|写道|写着|写入|添加一行|写上|文案|显示文本)[：:]|for example|\be[.]g[.]|\b(?:example|template|quote)\b|\b(?:says?|said|write|insert|add (?:the|a) line)\b[^.:]{0,50}:)/iu;
const negativeApproval = /(?:不必|不用|不需要|无需|无须|不要|别|跳过|取消|不能|不应)[^。！？!?，,；;\n]{0,20}(?:我.{0,8}(?:验收|确认|签收|审批|批准)|人工验收)|(?:\b(?:not|without|never|skip|no need)\b|n['’]t\b)[^.!?;,\n]{0,36}\bmy (?:final |explicit |personal )?(?:approval|acceptance|confirmation|sign[- ]off)\b/iu;
const intermediate = /(?:(?:验收|批准|确认|签收|审批)(?:通过)?(?:后|再)[^。！？!?；;\n]{0,8}(?:开始|开工|执行测试|开测|修改代码|运行命令)|\b(?:before|to)\s+(?:starting|start|testing|test|running|run|editing|edit)\b)/iu;

// “确认” can target a message, a time or permission to begin. Require a first-person
// approver and a final deliverable or completion point in the same instruction.
const confirmationActor = /(?:由我|交(?:给|由)?我|提交给我|发给我|让我|请我|等我|待我|我)(?:(?:本人|亲自|负责|会|将|来){0,2})(最终|最后)?(?:来)?确认(?:一下)?(最终结果|最终成果|交付结果|交付成果|最终交付物|结果|成果)?(?:通过)?(?:[后再]+(?:关闭|结束|结案))?[。.!；;]?\s*$/u;
const completionPoint = /(?:最终|最后|最终结果|最终成果|(?:修好|改好|完成(?:修复|测试|核验|检查|验证|工作|任务)?|测试通过|核验通过|验证通过|结束)(?:之|以)?后)\s*$/u;
const englishFinalConfirmation = /\bI(?:['’]ll|\s+(?:will|must|shall))\s+(?:personally\s+)?confirm\s+(?:the|your|this)\s+final\s+(?:results?|outcome|deliverable|delivery)\b(?=\s*(?:[.!;]|$|before (?:you )?(?:close|closing|finish|finishing)\b))/iu;

function finalConfirmation(clause: string, precedingClause: string): string|undefined {
  const english = clause.match(englishFinalConfirmation);
  if (english) return english[0];
  const actor = clause.match(confirmationActor);
  if (!actor) return;
  const before = clause.slice(0,actor.index);
  // Direction matters even with a member's name in the text (“向我本人确认”).
  if (/(?:向|跟|同|为)\s*$/u.test(before)) return;
  const phase = before.match(completionPoint);
  if (phase) return clause.slice(phase.index).trim().replace(/[。.!；;]$/u,'');
  if (actor[1] || /^(?:最终|交付)/u.test(actor[2] ?? '') || (!before.trim() && completionPoint.test(precedingClause))) {
    return actor[0].trim().replace(/[。.!；;]$/u,'');
  }
}

export function userAcceptanceQuote(raw: string): string | undefined {
  const direct = raw.replace(/(\x60{3,}|~{3,})[\s\S]*?(?:\1|$)/gu,' ')
    .replace(/^\s*>.*$/gmu,' ').replace(/\x60[^\x60\n]*(?:\x60|$)/gmu,' ')
    .replace(/“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|‘[^’]*(?:’|$)|"[^"]*(?:"|$)|(?:^|[\s:(])'[^'\n]*(?:'|$)/gmu,' ');
  let evidence: string|undefined;
  for (const paragraph of direct.split(/\n\s*\n/u)) {
    let continuedExample = false;
    for (const sentence of paragraph.match(/[^。！？!?;\n；.]+[。！？!?;\n；.]?/gu) ?? []) {
      if (exampleOrAttribution.test(sentence)) {
        continuedExample = /[:：]\s*$/u.test(sentence.trim()); continue;
      }
      if (continuedExample) {
        if (!/^\s*(?:实际|正式(?:要求|请求)|我的要求|actual(?:ly)?|my request)/iu.test(sentence)) continue;
        continuedExample = false;
      }
      if (/[?？]/u.test(sentence) || /(?:假设|假如|如果|\bif\b|\bhypothetically\b)/iu.test(sentence)) continue;
      const gate = sentence.match(reservedUntilApproval);
      if (gate) { evidence ??= gate[0]; continue; }
      const correction = /(?:更正|改为|改成|纠正|现在|instead|correction|now )/iu.test(sentence);
      const clauses = sentence.split(/[,，]/u);
      for (const [index,clause] of clauses.entries()) {
        if (correction && (negativeApproval.test(clause) || /(?:自动交付|直接交付|直接汇报|只需汇报|deliver automatically|deliver directly)/iu.test(clause))) {
          evidence = undefined; continue;
        }
        if (negativeApproval.test(clause) || disqualifier.test(clause) || intermediate.test(clause)) continue;
        const match = clause.match(humanApproval);
        evidence ??= match?.[0] ?? finalConfirmation(clause,clauses[index-1] ?? '');
      }
    }
  }
  return evidence;
}
