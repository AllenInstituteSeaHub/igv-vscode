/**
 * The subset of the igv.js 3.8.9 global API this extension uses. igv.js ships
 * a `dist/igv.d.ts`, but it is partial and does not describe the UMD global,
 * so we declare what we rely on. The contract test pins this surface.
 */
export interface IgvReferenceFrame {
  chr: string;
  start: number;
  end: number;
}

export interface IgvTrack {
  id?: string;
  name?: string;
  type?: string;
  config?: { format?: string; url?: unknown; name?: string; [k: string]: unknown };
  visibilityWindow?: number;
  trackView?: IgvTrackView;
  [key: string]: unknown;
}

export interface IgvTrackView {
  track: IgvTrack;
  setTrackHeight?(height: number, force?: boolean): void;
  repaintViews?(): void;
  checkContentHeight?(): void;
  updateViews?(): Promise<void>;
}

export interface IgvAlert {
  present(alert: unknown, callback?: () => void): void;
}

export interface IgvChromosome {
  name: string;
  bpLength: number;
}

export interface IgvGenome {
  id?: string;
  chromosomeNames?: string[];
  chromosomes?: Map<string, IgvChromosome> | Record<string, IgvChromosome>;
  getChromosomeName?(name: string): string;
}

export interface IgvBrowser {
  root: HTMLElement;
  genome: IgvGenome;
  referenceFrameList: IgvReferenceFrame[];
  trackViews: IgvTrackView[];
  alert: IgvAlert;
  currentLoci(): string | string[];
  search(locusOrGene: string | string[]): Promise<unknown>;
  loadTrack(config: Record<string, unknown>): Promise<IgvTrack>;
  removeTrack(track: IgvTrack): void;
  removeTrackByName(name: string): void;
  findTracks(property: string | ((t: IgvTrack) => boolean), value?: unknown): IgvTrack[];
  toSVG(): string;
  toJSON(): Record<string, unknown>;
  repaintViews(): void;
  updateViews(): Promise<void>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler?: (...args: unknown[]) => void): void;
}

export interface IgvGlobal {
  /** A function in 3.8.9 (`igv.version()`); older builds exposed a string. */
  version?: string | (() => string);
  createBrowser(container: HTMLElement, config: Record<string, unknown>): Promise<IgvBrowser>;
  removeBrowser(browser: IgvBrowser): void;
  removeAllBrowsers(): void;
}

declare global {
  const igv: IgvGlobal;
  interface Window {
    igv: IgvGlobal;
  }
}
