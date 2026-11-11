export interface ProjectPreviewState {
  status: 'idle' | 'starting' | 'running' | 'stopped' | 'failed';
  id?: string;
  url?: string;
  entry?: string;
  mode?: 'service';
  snapshot?: string;
  download?: {lock:string; count:number};
  logs: { time: string; message: string }[];
}

export interface PreviewHttpRequest {
  path: string; method: 'GET'|'POST'|'HEAD'; contentType: string; body: string;
}
export interface PreviewHttpResponse { status:number; mime:string; body:string }
export interface ProjectServiceRequest {
  grant: import('./collaboration.js').WorkspaceGrant;
  signal: AbortSignal;
  verify():void;
  log(message:string):void;
  allowDownload(lock:string, packages:string[]):Promise<boolean>;
  listening(request:(input:PreviewHttpRequest)=>Promise<PreviewHttpResponse>):void;
  snapshot(sha:string):void;
}
