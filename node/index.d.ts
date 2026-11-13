export interface RemoveBackgroundOptions {
  size?: "preview" | "small" | "regular" | "medium" | "hd" | "4k" | "full" | "auto";
  format?: "auto" | "png" | "jpg" | "webp" | "zip";
  channels?: "rgba" | "alpha";
  type?: "auto" | "person" | "product" | "car" | "animal" | "graphic" | "transportation";
  roi?: string;
  scale?: string;
  position?: string;
  bgColor?: string;
  bgImageUrl?: string;
  crop?: boolean;
  cropMargin?: string;
  addShadow?: boolean;
  shadowType?: "auto" | "car" | "drop" | "soft" | "contact" | "reflection" | "none";
  shadowOpacity?: number;
  semitransparency?: boolean;
  direct?: boolean;
  idempotencyKey?: string;
}

export interface RemoveBackgroundResult {
  buffer: Buffer;
  width: number;
  height: number;
  creditsCharged: number;
  mediaType: string;
}

export declare class RemoveAcError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string);
}

export declare class RemoveAcClient {
  constructor(options?: { baseUrl?: string; apiKey?: string; fetch?: typeof fetch });
  getAccount(): Promise<Record<string, unknown>>;
  removeBackground(
    input: string | Buffer | Uint8Array | ArrayBuffer,
    options?: RemoveBackgroundOptions,
  ): Promise<RemoveBackgroundResult>;
}

export declare function removeBackgroundFromImageFile(
  opts: RemoveBackgroundOptions & {
    path: string;
    apiKey?: string;
    baseUrl?: string;
    outputFile?: string;
    fetch?: typeof fetch;
  },
): Promise<RemoveBackgroundResult & { base64img: string }>;

export declare function removeBackgroundFromImageUrl(
  opts: RemoveBackgroundOptions & {
    url: string;
    apiKey?: string;
    baseUrl?: string;
    outputFile?: string;
    fetch?: typeof fetch;
  },
): Promise<RemoveBackgroundResult & { base64img: string }>;

export default RemoveAcClient;
