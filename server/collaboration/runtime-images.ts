import type { RuntimeImageInput, RuntimeRequest } from '../../shared/collaboration.js';

type ImageRequest = Pick<RuntimeRequest, 'prompt' | 'images'>;

// The GLM image adapter sometimes prints its temporary signed download URL as
// plain assistant text. Neither this bearer link nor echoed inline image data
// belongs in chat, evidence, or inputs created from the transcript.
export function redactRuntimeImages(text: string) {
  return text.replace(/https:\/\/glm-file\.bigmodel\.cn\/ccproxy\/file-input\/[^\s"'<>\\)\]]+/gi, '[截图链接已隐藏]')
    .replace(/data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+/gi, '[截图数据已隐藏]');
}

function dataUrl(image: RuntimeImageInput) {
  return 'data:' + image.mediaType + ';base64,' + image.base64;
}

export function codexInput(request: ImageRequest) {
  return [
    { type: 'text', text: request.prompt, text_elements: [] },
    ...(request.images ?? []).map(image => ({ type: 'image', url: dataUrl(image) })),
  ];
}

export function anthropicContent(request: ImageRequest) {
  return [
    ...(request.images ?? []).map(image => ({
      type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
    })),
    { type: 'text', text: request.prompt },
  ];
}

export function apiUserContent(request: ImageRequest, anthropic: boolean) {
  if (!request.images?.length) return request.prompt;
  if (anthropic) return anthropicContent(request);
  return [
    { type: 'text', text: request.prompt },
    ...request.images.map(image => ({ type: 'image_url', image_url: { url: dataUrl(image) } })),
  ];
}

export function checkImageTransport(request: RuntimeRequest) {
  if (!request.images?.length) return;
  if (request.member.carrier === 'hermes-agent') throw new Error('Hermes 当前仅支持文本。请选择支持图像的成员，或移除截图后重新发送。');
  if (request.projectWork && request.account.auth === 'api') {
    // The registered guest supervisor accepts model requests up to 4 MiB.
    // Reserve room for the CLI's system prompt, tool specifications and conversation.
    const encodedBytes = request.images.reduce((total, image) => total + image.base64.length, 0);
    if (encodedBytes > 2 * 1024 * 1024) throw new Error('本次项目 API 执行支持合计 1.5 MiB 以内的截图。请压缩图片或分条发送。');
  }
}
