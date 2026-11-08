export interface ProjectPreviewState {
  status: 'idle' | 'starting' | 'running' | 'stopped' | 'failed';
  id?: string;
  url?: string;
  entry?: string;
  logs: { time: string; message: string }[];
}
