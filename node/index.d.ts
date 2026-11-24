export type RemoveBgSize =
  | "preview"
  | "small"
  | "regular"
  | "medium"
  | "hd"
  | "4k"
  | "25mp"
  | "50mp"
  | "full"
  | "maximum"
  | "auto";

export type RemoveBgFormat = "auto" | "png" | "jpg" | "jpeg" | "webp" | "zip";
export type RemoveBgChannels = "rgba" | "alpha";
export type RemoveBgType =
  | "auto"
  | "person"
  | "product"
  | "car"
  | "animal"
  | "graphic"
  | "transportation";
export type RemoveBgShadowType =
  | "auto"
  | "car"
  | "drop"
  | "soft"
  | "contact"
  | "reflection"
  | "none";

export declare const SDK_VERSION: "1.3.2";
export declare const USER_AGENT: string;
export declare const MAX_COMBINED_UPLOAD_BYTES: number;
export declare const VALID_SIZES: readonly RemoveBgSize[];
export declare const VALID_FORMATS: readonly RemoveBgFormat[];
export declare const VALID_CHANNELS: readonly RemoveBgChannels[];
export declare const VALID_TYPES: readonly RemoveBgType[];
export declare const VALID_SHADOW_TYPES: readonly RemoveBgShadowType[];

export interface RemoveBackgroundOptions {
  size?: RemoveBgSize;
  format?: RemoveBgFormat;
  channels?: RemoveBgChannels;
  type?: RemoveBgType;
  typeLevel?: "none" | "1" | "2" | "latest";
  roi?: string;
  scale?: string;
  position?: string;
  bgColor?: string;
  bgImageUrl?: string;
  bgImageFile?: string | Buffer | Uint8Array | ArrayBuffer;
  bgImageFileB64?: string;
  crop?: boolean;
  cropMargin?: string;
  addShadow?: boolean;
  shadowType?: RemoveBgShadowType;
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

export interface SubmitImproveOptions {
  tag?: string;
  description?: string;
  filename?: string;
}

export interface SubmitImproveResult {
  id: string;
  status: string;
  [key: string]: unknown;
}

export declare function parseImageDimensions(
  bytes: Uint8Array | ArrayBuffer,
): { width: number; height: number } | null;

export declare function deriveSubIdempotencyKey(idem: string, suffix: string): string;

export declare class RemoveAcError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string);
}

export declare class RemoveAcClient {
  constructor(options?: { baseUrl?: string; apiKey?: string; fetch?: typeof fetch; lookup?: unknown });
  getAccount(): Promise<Record<string, unknown>>;
  removeBackground(
    input: string | Buffer | Uint8Array | ArrayBuffer,
    options?: RemoveBackgroundOptions,
  ): Promise<RemoveBackgroundResult>;
  submitImprove(
    input: string | Buffer | Uint8Array | ArrayBuffer,
    options?: SubmitImproveOptions,
  ): Promise<SubmitImproveResult>;
}

export declare function removeBackgroundFromImageFile(
  opts: RemoveBackgroundOptions & {
    path: string;
    apiKey?: string;
    baseUrl?: string;
    outputFile?: string;
    fetch?: typeof fetch;
    lookup?: unknown;
  },
): Promise<RemoveBackgroundResult & { base64img: string }>;

export declare function removeBackgroundFromImageUrl(
  opts: RemoveBackgroundOptions & {
    url: string;
    apiKey?: string;
    baseUrl?: string;
    outputFile?: string;
    fetch?: typeof fetch;
    lookup?: unknown;
  },
): Promise<RemoveBackgroundResult & { base64img: string }>;

export default RemoveAcClient;
