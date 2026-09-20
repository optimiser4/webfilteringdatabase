export interface ClientOptions {
  /** Default https://www.webfilteringdatabase.com/api */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 45000. */
  timeout?: number;
  /** Retries on network errors and 5xx responses. Default 2. */
  maxRetries?: number;
}

export interface CategoryScore {
  category: string;
  confidence: number | null;
}

export interface RawClassification {
  /** ["Category name: X", "Confidence: 0.9"] pairs for the 59-category web filtering taxonomy. */
  filtering_taxonomy?: string[][];
  /** IAB content taxonomy tier 1 pairs. */
  iab_taxonomy?: string[][];
  /** Newer IAB content taxonomy pairs, including tier 2 paths. */
  iab_taxonomy_version2?: string[][];
  buyer_personas?: string[];
  language?: string;
  status?: number;
  total_credits?: number;
  remaining_credits?: number;
  content_failed?: number;
  [key: string]: any;
}

export declare class Classification implements RawClassification {
  query: string;
  filtering: CategoryScore[];
  iab: CategoryScore[];
  iabV2: CategoryScore[];
  filtering_taxonomy?: string[][];
  iab_taxonomy?: string[][];
  iab_taxonomy_version2?: string[][];
  buyer_personas?: string[];
  language?: string;
  status?: number;
  total_credits?: number;
  remaining_credits?: number;
  content_failed?: number;
  readonly filteringCategories: string[];
  readonly primaryFilteringCategory: string | null;
  readonly iabCategories: string[];
  readonly iabV2Categories: string[];
  readonly personas: string[];
  readonly remainingCredits: number | null;
  inCategory(names: string | string[]): boolean;
  constructor(query: string, data: RawClassification);
}

export interface ManyOptions {
  /** Parallel requests. Default 4. */
  concurrency?: number;
  /** Pause after each request per worker, in milliseconds. Default 0. */
  pauseMs?: number;
}

export interface FailedLookup {
  query: string;
  error: string;
  status: number | null;
}

export declare class WebFilteringError extends Error {
  status?: number;
  body?: any;
  constructor(message: string, status?: number, body?: any);
}
export declare class AuthenticationError extends WebFilteringError {}
export declare class ClassificationError extends WebFilteringError {}
export declare class RateLimitError extends WebFilteringError {}

export declare function normalizeQuery(input: string): string;
export declare function parsePairs(list: string[][] | undefined): CategoryScore[];

export declare class WebFilteringClient {
  constructor(apiKey: string, options?: ClientOptions);
  classify(domainOrUrl: string): Promise<Classification>;
  category(domainOrUrl: string): Promise<string | null>;
  isInCategory(domainOrUrl: string, names: string | string[]): Promise<boolean>;
  classifyMany(domains: string[], options?: ManyOptions): Promise<Array<Classification | FailedLookup>>;
}

export default WebFilteringClient;
