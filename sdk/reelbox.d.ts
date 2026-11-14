// Reelbox 插件类型定义(给编辑器用,不参与运行)

export interface FilterOption { label: string; value: string }
export interface Filter { key: string; label: string; options: FilterOption[] }

export interface Item {
  id: string;
  title: string;
  poster?: string;
  subtitle?: string;
  kind?: string;
}

export interface Page { items: Item[]; next?: string }

export interface Episode { id: string; name: string }
export interface Group { name: string; episodes: Episode[] }

export interface Detail {
  title: string;
  poster?: string;
  summary?: string;
  groups: Group[];
}

export interface Stream {
  url: string;
  quality?: string;
  headers?: Record<string, string>;
  mime?: string;
}

export interface Ctx {
  /** 发 HTTP 请求,返回文本 */
  http: {
    get(url: string, init?: { headers?: Record<string, string> }): Promise<string>;
  };
  /** 取页面并提供一个类 jQuery 的选择器 */
  html: {
    load(url: string): Promise<Page2>;
  };
  /** 抛一个带分类的错误:network / parse / auth / unsupported */
  fail(code: string, message: string): never;
  log(...args: unknown[]): void;
}

export interface Page2 {
  url: string;
  $(sel: string | any): {
    length: number;
    each(fn: (i: number, el: any) => void): void;
    text(): string;
    attr(name: string): string | undefined;
  };
}

export interface Plugin {
  id: string;
  name: string;
  version?: string;
  api?: number;
  caps?: string[];
  filters?(ctx: Ctx): Promise<Filter[]>;
  list?(ctx: Ctx, args: { page?: number; cursor?: string; filters?: Record<string, string> }): Promise<Page>;
  search?(ctx: Ctx, args: { keyword: string; page?: number }): Promise<Page>;
  detail?(ctx: Ctx, args: { id: string }): Promise<Detail>;
  play?(ctx: Ctx, args: { id: string }): Promise<Stream | Stream[]>;
}

export interface Reelbox {
  define(plugin: Plugin): Plugin;
}

declare global {
  const reelbox: Reelbox;
}
