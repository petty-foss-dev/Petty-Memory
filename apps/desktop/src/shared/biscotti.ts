export interface BiscottiQuery {
  query?: string;
  after?: string;
  before?: string;
  limit?: number;
}

export interface BiscottiQueryResult {
  results: { id: string; title: string; date: string; querySnippet?: string }[];
  truncated: boolean;
}
