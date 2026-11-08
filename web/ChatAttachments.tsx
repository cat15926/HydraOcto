import { useEffect, useRef, useState } from 'react';
import type { ConversationAttachment } from '../shared/collaboration';
import './chat-attachments.css';

export type DraftAttachment = ConversationAttachment | {
  id: string;
  name: string;
  bytes: number;
  mediaType: string;
  file: File;
};

export const attachmentAccept = 'image/png,image/jpeg,image/webp,text/*,.md,.json,.csv,.ts,.tsx,.js,.py,.txt,.yaml,.yml';

export function imageType(file: File): string | undefined {
  if (file.type) return file.type.startsWith('image/') ? file.type : undefined;
  const ext = file.name.split('.').at(-1)?.toLowerCase();
  if (ext === 'png' || ext === 'webp') return 'image/' + ext;
  if (ext === 'jpeg' || ext === 'jpg') return 'image/jpeg';
}

export function validateFile(file: File) {
  const type = imageType(file);
  if (type && !['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Error('图片支持 PNG、JPEG 和 WebP 格式。');
  if (!file.size) throw new Error('文件为空，请重新选择。');
  if (type && file.size > 5 * 1024 * 1024) throw new Error('图片超过 5 MiB，请压缩后再添加。');
  if (!type && file.size > 32768) throw new Error('每个文本附件最多 32 KiB。');
}

export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('读取附件失败，请重新选择文件。'));
    reader.readAsDataURL(file);
  });
}

function ImageButton({ url, name, sent = false }: { url: string; name: string; sent?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState(false);
  return <>
    <button className={sent ? 'cc-attachment cc-sent-image' : 'cc-draft-image'} type="button" onClick={() => { setOpened(true); dialog.current?.showModal(); }} aria-label={'查看图片 ' + name}>
      {failed ? <span>查看原图</span> : <img src={url} alt="" loading={sent ? 'lazy' : undefined} onError={() => setFailed(true)} />}
      {sent && <span>{name}</span>}
    </button>
    <dialog className="cc-picture-dialog" ref={dialog} onClose={() => setOpened(false)} aria-label={'查看图片 ' + name}>
      <header><strong>{name}</strong><button type="button" autoFocus onClick={() => dialog.current?.close()}>关闭</button></header>
      {opened && <img src={url} alt={name} />}
    </dialog>
  </>;
}

export function DraftFile({ attachment, disabled, remove }: { attachment: DraftAttachment; disabled: boolean; remove: () => void }) {
  const file = 'file' in attachment ? attachment.file : undefined;
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file) return;
    const preview = URL.createObjectURL(file);
    setUrl(preview);
    return () => URL.revokeObjectURL(preview);
  }, [file]);
  return <div className="cc-composer-attachment cc-draft-file">
    {url && <ImageButton url={url} name={attachment.name} />}
    <span>{attachment.name}</span><button type="button" disabled={disabled} onClick={remove} aria-label={'移除附件 ' + attachment.name}>移除</button>
  </div>;
}

export function SentImage({ attachment }: { attachment: ConversationAttachment }) {
  const url = '/api/conversations/' + encodeURIComponent(attachment.conversationId) + '/attachments/' + encodeURIComponent(attachment.id) + '/image';
  return <ImageButton url={url} name={attachment.name} sent />;
}
