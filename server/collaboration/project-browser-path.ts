import { access,constants } from 'node:fs/promises';
export async function chromiumPath() {
  for(const path of [process.env.COLLAB_CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome']) {
    if(path?.startsWith('/') && await access(path,constants.X_OK).then(()=>true,()=>false)) return path;
  }
  throw new Error('本机没有可用的 Chrome 或 Chromium，请在平台运行环境中配置 COLLAB_CHROME_PATH 后重试。');
}
