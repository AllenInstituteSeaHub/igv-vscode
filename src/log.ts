import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Thin wrapper over the "IGV" output channel with viewer tags (spec §1.1, §10). */
export class Logger implements vscode.Disposable {
  readonly channel: vscode.OutputChannel;
  /** Also write to the console (stdout of the extension host). Set IGV_LOG_CONSOLE=1; used by integration tests. */
  private readonly mirrorToConsole: boolean;

  constructor(name = 'IGV') {
    this.channel = vscode.window.createOutputChannel(name);
    this.mirrorToConsole = process.env.IGV_LOG_CONSOLE === '1';
  }

  log(level: LogLevel, message: string, tag?: string): void {
    const ts = new Date().toISOString();
    const t = tag ? ` [${tag}]` : '';
    const line = `${ts} ${level.toUpperCase().padEnd(5)}${t} ${message}`;
    this.channel.appendLine(line);
    if (this.mirrorToConsole) console.log(`[IGV] ${line}`);
  }

  debug(message: string, tag?: string): void {
    this.log('debug', message, tag);
  }
  info(message: string, tag?: string): void {
    this.log('info', message, tag);
  }
  warn(message: string, tag?: string): void {
    this.log('warn', message, tag);
  }
  error(message: string | Error, tag?: string): void {
    const text = message instanceof Error ? `${message.message}${message.stack ? `\n${message.stack}` : ''}` : message;
    this.log('error', text, tag);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
