/** Expand the member's explicit receipt only in a plain text line of their final reply. */
export function expandDeliveryReply(content: string, marker: string, summary: string): string {
  const offset = content.indexOf(marker);
  if (offset < 0 || offset !== content.lastIndexOf(marker)) return content;
  const lines = content.split('\n');
  const index = lines.findIndex(line => line.replace(/\r$/, '') === marker);
  if (index < 0) return content;

  let fence = '', inline = '', quoted = false, html = '';
  for (const raw of lines.slice(0, index)) {
    const line = raw.replace(/\r$/, '');
    if (html) {
      if (line.toLowerCase().includes(html)) html = '';
      continue;
    }
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (close?.startsWith(fence)) fence = '';
      continue;
    }
    if (!line.trim()) { inline = ''; quoted = false; continue; }
    if (/^ {0,3}>/.test(line)) { quoted = true; continue; }
    const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (openingFence) { fence = openingFence; inline = ''; quoted = false; continue; }
    const openingHtml = line.match(/<!--|<(blockquote|pre|code)\b[^>]*>/i);
    if (openingHtml) {
      const end = openingHtml[1] ? '</' + openingHtml[1].toLowerCase() + '>' : '-->';
      if (!line.slice(openingHtml.index! + openingHtml[0].length).toLowerCase().includes(end)) html = end;
    }
    for (const ticks of line.match(/`+/g) ?? []) {
      if (!inline) inline = ticks;
      else if (inline === ticks) inline = '';
    }
  }
  if (fence || inline || quoted || html) return content;
  if (content.slice(0,offset).includes(summary) || content.slice(offset + marker.length).includes(summary)) lines.splice(index, 1);
  else lines[index] = summary + (lines[index]!.endsWith('\r') ? '\r' : '');
  return lines.join('\n');
}
