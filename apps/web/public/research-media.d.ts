export function createAudioRecorder(callbacks: {
  onComplete: (blob: Blob) => void;
  onError: (message: string) => void;
  onState: (recording: boolean) => void;
}): { start(): Promise<void>; stop(): void; dispose(): void };
export function openResearchPdf(bytes: Uint8Array | ArrayBuffer): Promise<{
  pageCount: number;
  render(page: number, canvas: HTMLCanvasElement): Promise<string>;
  close(): Promise<void>;
}>;
export function canvasPng(canvas: HTMLCanvasElement): Promise<Blob>;
