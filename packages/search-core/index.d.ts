export interface LineResult {
  line_id: number;
  verse_id: number;
  shabad_id: number;
  ang: number;
  line_no?: number | null;
  position_in_shabad: number;
  gurmukhi_uni: string;
  gurmukhi_ascii: string;
  first_letters_ascii: string;
  first_letters_codes: string;
  kind: string;
  rahao_kind: string;
  writer?: string | null;
  raag?: string | null;
  score?: number;
  highlight?: { firstWord: number; lastWord: number } | null;
}

export interface ShabadResult {
  shabad_id: number;
  writer?: string | null;
  raag?: string | null;
  ang_start: number;
  line_count: number;
  has_rahao: number;
  rahao_line?: string | null;
  first_line?: string | null;
  score?: number;
}

export interface DbAdapter {
  all(sql: string, params?: any[]): any[];
  close(): void;
}

export interface SemanticHit {
  id: number;
  row: number;
  score: number;
}

export interface VectorIndex {
  search(query: Float32Array, k?: number, opts?: { excludeRow?: number; filter?: (id: number) => boolean }): SemanticHit[];
  similarTo(id: number, k?: number, opts?: { filter?: (id: number) => boolean }): SemanticHit[];
}

export interface LoadedArtifacts {
  manifest: any;
  lines: VectorIndex;
  shabads: VectorIndex;
  rahao: VectorIndex;
  pca: {
    components: Float32Array;
    mean: Float32Array;
    inDim: number;
    outDim: number;
  };
}

export function openNodeAdapter(dbPath: string, opts?: { readOnly?: boolean }): DbAdapter;
export function firstLetterAnywhere(db: DbAdapter, input: string, opts?: { limit?: number }): LineResult[];
export function firstLetterStart(db: DbAdapter, input: string, opts?: { limit?: number }): LineResult[];
export function firstLetterAnywhereCount(db: DbAdapter, input: string): number;

export function similarLines(art: LoadedArtifacts, lineId: number, k?: number): SemanticHit[];
export function similarShabads(art: LoadedArtifacts, shabadId: number, k?: number): SemanticHit[];
export function similarByRahao(art: LoadedArtifacts, shabadId: number, k?: number): SemanticHit[];
export function searchText(art: LoadedArtifacts, queryVec: Float32Array, level?: 'lines' | 'shabads' | 'rahao', k?: number): SemanticHit[];
export function projectQuery(pca: any, embedding: Float32Array): Float32Array;
export function loadArtifacts(readFile: (name: string) => Promise<ArrayBuffer | Uint8Array>, opts?: { semantic?: boolean }): Promise<LoadedArtifacts>;
export function nodeReadFile(dir: string): (name: string) => Promise<Buffer>;

export const keyboard: {
  PAINTI: string[][];
  NUKTA_ROW: string[];
  ALL_KEYS: string[];
  keyToAscii(letter: string): string;
  matchSpan(firstLettersAscii: string, input: string): { start: number; length: number } | null;
  firstLetterWordMap(asciiLine: string): { words: string[]; wordOf: number[] };
  highlightWords(asciiLine: string, firstLettersAscii: string, input: string): { firstWord: number; lastWord: number } | null;
};

export const gurmukhi: {
  toAscii(unicodeStr: string): string;
  toUnicode(asciiStr: string): string;
  firstLettersAscii(asciiStr: string): string;
  buildQuery(rawInput: string): string;
  bindiVariant(charCodeQuery: string): string | null;
  stripNukta(input: string): string;
  suffixTokens(charCodeStr: string): string[];
};

/* ---- keertan notations (notations.js) ---------------------------------- */

export interface NotationCard {
  notation_id: string;
  book_key: string;
  book_title: string;
  book_title_en?: string | null;
  part?: number | null;
  author_key: string;
  author: string;
  page_start: number;
  page_end: number;
  kind: 'notation' | 'partial' | 'reet-ref' | 'non-gurbani';
  shabad_id: number | null;
  shabad_source?: string | null;
  ang: number | null;
  first_line: string | null;
  /** the line a query matched, when it is not the first line */
  matched_line?: string;
  translit_roman: string | null;
  writer: string | null;
  raag_shabad?: string | null;
  raag_shabad_key?: string | null;
  raag_used?: string | null;
  raag_used_key?: string | null;
  raag_used_parent_key?: string | null;
  raag_used_en?: string | null;
  raag_differs: boolean;
  taal?: string | null;
  taal_key?: string | null;
  taal_en?: string | null;
  matras?: number | null;
  laya?: string | null;
  partaal: boolean;
  sections: number;
  beats: number;
  has_grid: boolean;
  confidence: number;
  verified: boolean;
  review_status: 'accepted' | 'backlog' | null;
  review_comment: string | null;
  flags: string[];
  image_count: number;
  thumb: { url: string | null; path: string | null } | null;
}

export interface NotationImage {
  n: number;
  kind: 'full' | 'thumb';
  role: 'grid' | 'shabad' | 'heading';
  page: number;
  path?: string;
  url: string | null;
  bbox: number[] | null;
  w: number | null;
  h: number | null;
  bytes: number;
  sha256: string;
}

export interface NotationsFilter {
  raag?: string | null;
  shabadRaag?: string | null;
  author?: string | null;
  book?: string | null;
  taal?: string | null;
  shabad?: number | null;
  q?: string;
  verified?: boolean;
  k?: number;
  page?: number;
}

export interface NotationsSummary {
  enabled: boolean;
  books: number;
  notations: number;
  shabads: number;
  images: number;
  images_published: number;
  verified: number;
  parser_version: string | null;
  vocab_version: string | null;
  built: string | null;
}

export class NotationsStore {
  constructor(opts: { db: DbAdapter; gurbani?: DbAdapter | null });
  meta: Record<string, string>;
  summary(): NotationsSummary;
  roster(): NotationsSummary & { raags: any[]; taals: any[]; authors: any[]; books: any[] };
  countFor(shabadId: number): number;
  attachCounts<T extends { shabad_id?: number | null }>(rows: T[]): T[];
  known(kind: 'raag' | 'taal' | 'author' | 'book', key: string): boolean;
  list(filter?: NotationsFilter): { total: number; page: number; pages?: number; k: number; results: NotationCard[] };
  get(notationId: string): { notation: NotationCard & { heading: string | null; grid: any[] | null; images: NotationImage[]; sargam_en: string | null; others: number }; shabad: any | null } | null;
  shabadHeader(shabadId: number): any;
  static imageUrl(image: { url?: string | null; path?: string | null } | null, opts?: { localBase?: string | null; urlBase?: string | null; releaseBase?: string | null }): string | null;
}
export const NOTATION_COLUMNS: Record<string, string[]>;
